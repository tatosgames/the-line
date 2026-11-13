const loader = document.querySelector<HTMLElement>('#boot-loader')!;
const ring = loader.querySelector<SVGSVGElement>('.boot-ring')!;
const arc = loader.querySelector<SVGCircleElement>('#boot-progress')!;
const errorView = loader.querySelector<HTMLElement>('#boot-error')!;

function progress(value: number) {
  arc.style.strokeDashoffset = String(100 - value);
  ring.setAttribute('aria-valuenow', String(value));
}

async function boot() {
  // Let the browser paint the HTML loader before importing the game.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  let timer = 0;
  let expired = false;
  try {
    const start = await Promise.race([
      import('./main').then(({ prepareGame }) => {
        if (expired) throw new Error('Game startup timed out');
        progress(35);
        return prepareGame(() => { if (!expired) progress(85); });
      }),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          expired = true;
          reject(new Error('Game startup timed out'));
        }, 20_000);
      }),
    ]);
    clearTimeout(timer);
    progress(100);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await loader.animate([{ opacity: 1 }, { opacity: 0 }], 160).finished;
    }
    start();
    loader.remove();
  } catch (error) {
    clearTimeout(timer);
    console.error('The Line could not start.', error);
    ring.remove();
    errorView.hidden = false;
    const retry = errorView.querySelector('button')!;
    retry.onclick = () => location.reload();
    retry.focus();
  }
}

void boot();
