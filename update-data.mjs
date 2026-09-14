// 로또 6/45 당첨번호 데이터 갱신 스크립트 (Node 18+, 의존성 없음)
// 사용법: node update-data.mjs
//  - data/lotto-data.js 가 없으면 공개 미러(all.json)로 초기 데이터를 받고
//  - 이후 동행복권 공식 API로 누락/신규 회차를 채우며, 최근 회차를 공식 데이터로 교차 검증합니다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = new URL('./data/lotto-data.js', import.meta.url);
const OFFICIAL = (n) => `https://www.dhlottery.co.kr/lt645/selectPstLt645Info.do?srchLtEpsd=${n}`;
const MIRROR = 'https://smok95.github.io/lotto/results/all.json';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
  'Referer': 'https://www.dhlottery.co.kr/',
  'X-Requested-With': 'XMLHttpRequest',
};
const VERIFY_RECENT = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 레코드 형식: [회차, 'YYYY-MM-DD', n1..n6, 보너스, 1등 1인당 당첨금, 1등 당첨자 수]
async function fetchOfficial(n) {
  const res = await fetch(OFFICIAL(n), { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} (회차 ${n})`);
  const text = await res.text();
  if (!text.trimStart().startsWith('{')) throw new Error(`JSON 아님 (회차 ${n})`);
  const item = JSON.parse(text)?.data?.list?.find((d) => d.ltEpsd === n);
  if (!item) return null;
  const y = item.ltRflYmd;
  const nums = [item.tm1WnNo, item.tm2WnNo, item.tm3WnNo, item.tm4WnNo, item.tm5WnNo, item.tm6WnNo].sort((a, b) => a - b);
  return [n, `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`, ...nums, item.bnsWnNo, item.rnk1WnAmt ?? 0, item.rnk1WnNope ?? 0];
}

async function fetchMirror() {
  const res = await fetch(MIRROR);
  if (!res.ok) throw new Error(`미러 HTTP ${res.status}`);
  return (await res.json()).map((d) => [
    d.draw_no, d.date.slice(0, 10), ...[...d.numbers].sort((a, b) => a - b), d.bonus_no,
    d.divisions?.[0]?.prize ?? 0, d.divisions?.[0]?.winners ?? 0,
  ]);
}

async function load() {
  if (!existsSync(OUT)) return [];
  const src = await readFile(OUT, 'utf8');
  const start = src.indexOf('[', src.indexOf('window.LOTTO_DATA'));
  return JSON.parse(src.slice(start, src.lastIndexOf(']') + 1));
}

const same = (a, b) => a.slice(0, 9).join() === b.slice(0, 9).join();

async function main() {
  let draws = await load();
  if (draws.length === 0) {
    console.log('초기 데이터 다운로드 (미러)...');
    draws = await fetchMirror();
    console.log(`  ${draws.length}회차 수신`);
  }
  const map = new Map(draws.map((d) => [d[0], d]));
  const last = Math.max(0, ...map.keys());

  // 누락 회차 채우기
  for (let n = 1; n <= last; n++) {
    if (map.has(n)) continue;
    const d = await fetchOfficial(n);
    if (d) { map.set(n, d); console.log(`  누락 회차 ${n} 보충`); }
    await sleep(150);
  }

  // 최근 회차 공식 데이터로 교차 검증 (공식 API 접근 실패 시 건너뜀)
  let officialOk = true, mismatches = 0;
  try {
    for (let n = Math.max(1, last - VERIFY_RECENT + 1); n <= last; n++) {
      const d = await fetchOfficial(n);
      if (d && !same(d, map.get(n))) { mismatches++; console.warn(`  회차 ${n} 불일치 → 공식 데이터로 교체`); }
      if (d) map.set(n, d);
      await sleep(150);
    }
    console.log(`최근 ${VERIFY_RECENT}회차 검증 완료 (불일치 ${mismatches}건)`);
  } catch (e) {
    officialOk = false;
    console.warn(`공식 API 접근 실패 (${e.message}) → 미러로 대체`);
  }

  // 신규 회차: 공식 API 우선, 실패하면 미러
  let added = 0;
  const addDraw = (d) => { map.set(d[0], d); added++; console.log(`  신규 ${d[0]}회 (${d[1]}): ${d.slice(2, 8).join(', ')} + ${d[8]}`); };
  if (officialOk) {
    try {
      for (let n = last + 1; ; n++) {
        const d = await fetchOfficial(n);
        if (!d) break;
        addDraw(d);
        await sleep(150);
      }
    } catch (e) {
      officialOk = false;
      console.warn(`공식 API 접근 실패 (${e.message}) → 미러로 대체`);
    }
  }
  if (!officialOk) {
    const top = Math.max(0, ...map.keys());
    for (const d of await fetchMirror()) if (d[0] > top) addDraw(d);
  }

  const out = [...map.values()].sort((a, b) => a[0] - b[0]);
  await mkdir(new URL('./data/', import.meta.url), { recursive: true });
  const body = out.map((d) => JSON.stringify(d)).join(',\n');
  await writeFile(OUT, `// 자동 생성: node update-data.mjs (${new Date().toISOString()})\n// [회차, 추첨일, n1..n6, 보너스, 1등당첨금, 1등당첨자수]\nwindow.LOTTO_DATA = [\n${body}\n];\n`);
  console.log(`저장 완료: 총 ${out.length}회차 (신규 ${added}), 최신 ${out.at(-1)[0]}회 ${out.at(-1)[1]}`);
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1); });
