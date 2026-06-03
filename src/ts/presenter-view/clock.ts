const clockEl = document.getElementById("pv-clock")!;
const elapsedEl = document.getElementById("pv-elapsed")!;
const startTime = Date.now();

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

export function updateClock(): void {
    const now = new Date();
    clockEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const elapsed =
        h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
    elapsedEl.textContent = `elapsed ${elapsed}`;
}
