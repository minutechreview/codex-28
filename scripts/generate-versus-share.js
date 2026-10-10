/** Original, offline share-card source generated from the same immutable model as the UI. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersusState, validateVersusData } from '../versus-model.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_HTML = resolve(ROOT, 'output/playwright/versus-share.html');
const DEFAULT_METADATA = resolve(ROOT, 'assets/versus-share-metadata.json');
const IMAGE_URL = 'https://minutechreview.github.io/codex-28/assets/versus-share.png';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function countersText(team, totals) {
  if (totals.unclassified) {
    return `${team.team}: hits and resets UNKNOWN; ${totals.confirmedHits} confirmed hits, ${totals.confirmedResets} confirmed resets, ${totals.unclassified} unclassified records.`;
  }
  return `${team.team}: ${totals.confirmedHits} confirmed hits, ${totals.confirmedResets} resets, ${totals.pending} pending days.`;
}

/** Build imports this helper to keep OG/image alt text synchronized with source data. */
export function createShareMetadata(data, hashes = {}, now = new Date()) {
  const state = getVersusState(data, now);
  const description = ['dots', 'bots'].map(side => countersText(data.teams[side], state.totals[side])).join(' ');
  return {
    title: `CODEX 28 — ${data.teams.dots.team.toUpperCase()} VS ${data.teams.bots.team.toUpperCase()}`,
    description,
    imageAlt: `Original arcade VERSUS card with portraits of ${data.teams.dots.name} and ${data.teams.bots.name}. ${description}`,
    imageUrl: IMAGE_URL,
    imageWidth: 1200,
    imageHeight: 630,
    currentDate: state.currentDate,
    round: state.round,
    totalRounds: data.days.length,
    phase: state.phase,
    counters: state.totals,
    sourceUpdatedAt: { dots: data.tracker.updatedAt, bots: data.updatedAt },
    hashes,
  };
}

/** Safe HTML attributes ready to insert into the built static document. */
export function shareMetaTags(metadata) {
  const tags = [
    ['og:title', metadata.title], ['og:description', metadata.description],
    ['og:image', metadata.imageUrl], ['og:image:alt', metadata.imageAlt],
    ['og:image:width', metadata.imageWidth], ['og:image:height', metadata.imageHeight],
  ];
  return tags.map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content)}">`).join('\n');
}

function stat(label, value, confirmed) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong class="${value === null ? 'unknown' : ''}">${value === null ? 'UNKNOWN' : escapeHtml(value)}</strong>${value === null ? `<small>${escapeHtml(confirmed)} CONFIRMED</small>` : ''}</div>`;
}

function fighter(side, team, totals, portrait) {
  const note = totals.unclassified ? `${totals.unclassified} UNCLASSIFIED SOURCE RECORDS` : 'ONE HIT PER SHIPPED UPDATE';
  return `<article class="fighter ${side}">
    <div class="team"><b>${escapeHtml(team.team.toUpperCase())}</b><span>${side === 'dots' ? '1P' : '2P'}</span></div>
    <div class="player"><div class="portrait"><img src="${portrait}" alt="${escapeHtml(team.name)}"><span>${side === 'dots' ? '01' : '02'} / SELECTED</span></div>
    <div class="details"><p class="handle">@${escapeHtml(team.handle)}</p><h2>${escapeHtml(team.name)}</h2><p class="product">${escapeHtml(team.product)}</p>
    <div class="stats">${stat('IMPROVEMENTS / HITS', totals.hits, totals.confirmedHits)}${stat('RESETS', totals.resets, totals.confirmedResets)}</div></div></div>
    <p class="note">${escapeHtml(note)}</p>
  </article>`;
}

export function generateShareHtml(data, metadata, portraits, fontSource = '') {
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(new Date(`${metadata.currentDate}T12:00:00Z`)).toUpperCase();
  const json = JSON.stringify(metadata).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1200"><title>${escapeHtml(metadata.title)}</title>
${shareMetaTags(metadata)}
<style>
${fontSource ? `@font-face{font-family:Arcade;src:url("${fontSource}") format("truetype");font-style:normal;font-weight:400;font-display:block}` : ''}
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}body{color:#f6f8fb;background:#090b10;font-family:Arial,Helvetica,sans-serif}
.canvas{position:relative;width:1200px;height:630px;padding:36px 52px 28px;background:radial-gradient(ellipse at 8% 45%,#153424 0,transparent 46%),radial-gradient(ellipse at 95% 50%,#271b43 0,transparent 45%),#090b10}
.canvas:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.13;background:repeating-linear-gradient(0deg,transparent 0,transparent 3px,#000 3px,#000 5px)}
header,main,footer{position:relative;z-index:1}header{display:flex;justify-content:space-between;align-items:flex-start;height:106px}.logo{font-family:Arcade,"Courier New",monospace;font-size:27px;font-weight:400;letter-spacing:-2px;margin:0}.logo i{font-style:normal;color:#75fca8}.logo span{font-size:16px;letter-spacing:0;color:#94a0ac;margin-left:12px}.eyebrow{color:#aeb8c4;font-family:Arcade,"Courier New",monospace;font-size:8px;letter-spacing:1px;margin:17px 0 0}.round{text-align:right;font-family:Arcade,"Courier New",monospace}.round p{font-size:13px;font-weight:400;margin:0 0 16px}.round strong{color:#75fca8}.round span{color:#9aa8b7;font-size:9px;letter-spacing:.3px}
main{display:grid;grid-template-columns:470px 156px 470px;align-items:center}.fighter{height:375px;border:4px solid var(--accent);background:#10161b;box-shadow:8px 8px 0 #020609,0 0 22px var(--glow);position:relative}.dots{--accent:#75fca8;--glow:#75fca829}.bots{--accent:#c39bff;--glow:#c39bff29}.team{height:46px;border-bottom:4px solid var(--accent);display:flex;align-items:center;justify-content:space-between;padding:0 17px;background:#111a1a;color:var(--accent);font-family:"Courier New",monospace;font-size:19px;letter-spacing:1px}.team span{font-size:13px}.bots .team{background:#20192e}.player{display:grid;grid-template-columns:181px 1fr;height:276px}.portrait{position:relative;border-right:4px solid var(--accent);overflow:hidden;background:#12191e}.portrait img{width:100%;height:100%;object-fit:cover;object-position:center 25%;filter:saturate(.8) contrast(1.03)}.portrait span{position:absolute;bottom:8px;left:10px;color:#fff;font-family:"Courier New",monospace;font-size:10px;letter-spacing:1px;background:#000b;padding:5px 6px}.details{padding:15px 19px 10px}.handle{color:var(--accent);font-family:"Courier New",monospace;font-size:13px;letter-spacing:1px;margin:0 0 8px}h2{margin:0;font-size:32px;line-height:1.03;letter-spacing:-.6px}.product{color:#c2cbd6;font-size:12px;height:19px;margin:7px 0 13px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{display:flex;flex-direction:column;border-top:1px solid #47505c;padding-top:10px}.stat>span{font-family:"Courier New",monospace;font-size:9px;font-weight:900;color:#b7c3d0;letter-spacing:.5px;min-height:26px}.stat strong{font-family:"Courier New",monospace;font-size:57px;line-height:1;color:var(--accent)}.stat strong.unknown{font-size:18px;letter-spacing:-1px;margin-top:8px;margin-bottom:15px}.stat small{color:#f0e8fd;font-size:9px;font-family:"Courier New",monospace;letter-spacing:.4px}.note{height:45px;margin:0;border-top:1px solid #313b46;display:flex;align-items:center;justify-content:center;font-family:"Courier New",monospace;font-size:11px;letter-spacing:.4px;color:#c3cedb;background:#0c1119}
.vs{text-align:center;transform:rotate(-7deg)}.vs strong{display:block;color:#fff4ae;font-family:"Courier New",monospace;font-size:79px;line-height:1;font-weight:900;font-style:italic;letter-spacing:-11px;text-shadow:6px 6px 0 #af5325,0 0 30px #ffd86666}.vs span{display:block;transform:rotate(7deg);font-family:"Courier New",monospace;font-size:9px;letter-spacing:2px;margin:26px 0 0 5px;color:#aab5c2}
footer{display:flex;align-items:flex-end;justify-content:space-between;padding-top:37px}.tagline{font-size:22px;font-weight:900;letter-spacing:-.4px;margin:0}.tagline b{color:#75fca8}.disclaimer{margin:9px 0 0;font-size:11px;color:#9eaebe}.address{font-family:"Courier New",monospace;font-size:12px;letter-spacing:1px;color:#c2cbd6;text-align:right;margin:0 0 1px}.address span{display:block;color:#9b7dcb;font-size:10px;margin-top:10px}
.team,.handle,.stat>span,.stat strong,.stat small,.note,.portrait span,.vs strong,.vs span,.address{font-family:Arcade,"Courier New",monospace;font-weight:400}.team{font-size:13px;letter-spacing:.5px}.team b{font-weight:400}.team span{font-size:9px}.handle{font-size:9px;letter-spacing:0;margin-bottom:11px}.stat>span{font-size:7px;letter-spacing:0;line-height:1.55}.stat strong{font-size:46px;padding-top:6px}.stat strong.unknown{font-size:12px;letter-spacing:-.3px;padding-top:0;margin-top:13px;margin-bottom:17px}.stat small{font-size:7px;letter-spacing:0}.note{font-size:8px;letter-spacing:0}.portrait span{font-size:7px;letter-spacing:0}.vs strong{font-size:62px;letter-spacing:-7px;text-shadow:5px 5px 0 #af5325,0 0 30px #ffd86666}.vs span{font-size:7px;letter-spacing:.3px}.address{font-size:8px;letter-spacing:0}.address span{font-size:6px}
</style></head><body><div class="canvas" role="img" aria-label="${escapeHtml(metadata.imageAlt)}">
<header><div><h1 class="logo">C<i>O</i>DEX<span>28</span></h1><p class="eyebrow">THE 28-DAY SHIP WATCH / PLAYER SELECT</p></div><div class="round"><p>ROUND <strong>${String(metadata.round).padStart(2, '0')}</strong> / ${metadata.totalRounds}</p><span>${escapeHtml(date)} · PACIFIC TIME</span></div></header>
<main>${fighter('dots', data.teams.dots, metadata.counters.dots, portraits.dots)}<div class="vs" aria-hidden="true"><strong>VS</strong><span>LET'S SHIP</span></div>${fighter('bots', data.teams.bots, metadata.counters.bots, portraits.bots)}</main>
<footer><div><p class="tagline">EVERY SHIP <b>IS A HIT.</b> RESETS STAY SEPARATE.</p><p class="disclaimer">Not affiliated with OpenAI or SpaceXAI. Fan-made tracker.</p></div><p class="address">minutechreview.github.io/codex-28<span>SOURCED RECORDS. NO INVENTED RESULTS.</span></p></footer>
</div><script type="application/json" id="share-metadata">${json}</script></body></html>\n`;
}

export async function writeShareSource({ now = new Date(), htmlPath = DEFAULT_HTML, metadataPath = DEFAULT_METADATA } = {}) {
  const [trackerBytes, versusBytes] = await Promise.all([
    readFile(resolve(ROOT, 'data.json')), readFile(resolve(ROOT, 'versus.json')),
  ]);
  const data = validateVersusData(JSON.parse(trackerBytes), JSON.parse(versusBytes));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const hashes = { 'data.json': hash(trackerBytes), 'versus.json': hash(versusBytes) };
  const metadata = createShareMetadata(data, hashes, now);
  const portraits = {};
  const fontBytes = await readFile(resolve(ROOT, 'assets/PressStart2P-Regular.ttf'));
  const fontSource = `data:font/ttf;base64,${fontBytes.toString('base64')}`;
  for (const side of ['dots', 'bots']) {
    const image = await readFile(resolve(ROOT, data.teams[side].avatar));
    const extension = extname(data.teams[side].avatar).slice(1).toLowerCase();
    const mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' })[extension] ?? `image/${extension}`;
    portraits[side] = `data:${mime};base64,${image.toString('base64')}`;
  }
  await mkdir(dirname(htmlPath), { recursive: true });
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(htmlPath, generateShareHtml(data, metadata, portraits, fontSource));
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return { htmlPath, metadataPath, metadata };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || !['--now', '--html', '--metadata'].includes(flag)) throw new Error('Use --now ISO_TIMESTAMP, --html PATH, or --metadata PATH.');
    if (flag === '--now') options.now = new Date(value);
    else options[flag === '--html' ? 'htmlPath' : 'metadataPath'] = resolve(value);
  }
  const result = await writeShareSource(options);
  console.log(JSON.stringify({ html: result.htmlPath, metadata: result.metadataPath, imageAlt: result.metadata.imageAlt, hashes: result.metadata.hashes }, null, 2));
}
