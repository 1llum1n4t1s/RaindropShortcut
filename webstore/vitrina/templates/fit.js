// fit.js — スライド内の文言を段階縮小して収める（compose.mjs がページへ注入し、window.__vitrinaFit() を呼ぶ）。
// 規則（DESIGN-BRIEF）: 見出し 56→52→48→44（下限 44、最大 3 行）、補足 24→22→20。収まらなければ失敗（省略・切り捨て禁止）。
// 各要素に data-fit="<名前>" data-sizes="56,52,48,44" data-max-lines="3" を付ける。
// 全要素を同じ「段」で縮める（段 k のサイズ = sizes[min(k, 末尾)]）。見出しと補足の釣り合いを保つため。
window.__vitrinaFit = function () {
  const els = [...document.querySelectorAll("[data-fit]")];
  const containers = [...document.querySelectorAll("[data-contain]")];
  const safe = [...document.querySelectorAll("[data-safe]")];
  const W = document.body.clientWidth;
  const H = document.body.clientHeight;
  const SAFE = 64;
  const maxLevel = Math.max(0, ...els.map((e) => e.dataset.sizes.split(",").length - 1));

  const lineCount = (el) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return Math.round(el.getBoundingClientRect().height / lh);
  };
  const apply = (level) => {
    for (const el of els) {
      const sizes = el.dataset.sizes.split(",").map(Number);
      el.style.fontSize = `${sizes[Math.min(level, sizes.length - 1)]}px`;
    }
  };
  const problemsAt = () => {
    const problems = [];
    for (const el of els) {
      const max = Number(el.dataset.maxLines || 99);
      if (lineCount(el) > max) problems.push({ kind: "too-many-lines", name: el.dataset.fit, lines: lineCount(el), max });
      if (el.scrollWidth > el.clientWidth + 1) problems.push({ kind: "overflow-x", name: el.dataset.fit, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
    for (const c of containers) {
      if (c.scrollHeight > c.clientHeight + 1) problems.push({ kind: "container-overflow-y", name: c.dataset.contain, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight });
      if (c.scrollWidth > c.clientWidth + 1) problems.push({ kind: "container-overflow-x", name: c.dataset.contain, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth });
    }
    for (const el of safe) {
      const r = el.getBoundingClientRect();
      if (r.left < SAFE - 1 || r.top < SAFE - 1 || r.right > W - SAFE + 1 || r.bottom > H - SAFE + 1) {
        problems.push({ kind: "outside-safe-area", name: el.dataset.safe, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
      }
    }
    return problems;
  };

  let problems = [];
  let level = 0;
  for (; level <= maxLevel; level++) {
    apply(level);
    problems = problemsAt();
    if (!problems.length) break;
  }
  const used = Math.min(level, maxLevel);
  return {
    ok: problems.length === 0,
    level: used,
    sizes: Object.fromEntries(els.map((el) => [el.dataset.fit, el.style.fontSize])),
    problems,
  };
};
