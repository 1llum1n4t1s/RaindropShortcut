// ランディングページの軽量スクリプト。スクロール表示と比較パネルの切り替えだけを担う。
document.documentElement.classList.add("js");

const reveal = () => {
  const targets = Array.from(document.querySelectorAll(".reveal"));
  // js クラスを外すと .js .reveal の初期非表示ルールごと無効になるため、
  // トランジションが進まない環境でも確実に本文が見える状態に戻せる。
  const showAll = () => {
    document.documentElement.classList.remove("js");
    targets.forEach((el) => el.classList.add("is-visible"));
  };

  if (!("IntersectionObserver" in window)) {
    showAll();
    return;
  }

  // 初期表示に入っている要素は待たずに出す（オブザーバーの初回通知を待つと一瞬空白になるため）。
  targets.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.top < innerHeight && rect.bottom > 0) el.classList.add("is-visible");
  });

  let observed = false;
  const observer = new IntersectionObserver(
    (entries) => {
      observed = true;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
  );
  targets.forEach((el) => observer.observe(el));

  // 何らかの理由でオブザーバーが一度も通知しない環境では、本文が読めなくならないよう全て表示する。
  setTimeout(() => {
    if (!observed) showAll();
  }, 1500);
};

const compare = () => {
  const panel = document.querySelector(".panel");
  if (!panel) return;
  const buttons = panel.querySelectorAll(".mode-button");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      panel.dataset.mode = button.dataset.mode;
      buttons.forEach((other) => {
        const active = other === button;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", String(active));
      });
    });
  });
};

reveal();
compare();
