// Savings calculator: plain arithmetic on the visitor's own numbers.
(function () {
  const $ = (id) => document.getElementById(id);
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  const num = (id, min, max) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
  };
  const WEEKS_PER_MONTH = 52 / 12;

  function update() {
    const providers = Math.round(num('c-providers', 1, 500));
    const cancels = num('c-cancels', 0, 100);
    const today = num('c-today', 0, 100) / 100;
    const withSb = num('c-with', 0, 100) / 100;
    const revenue = num('c-revenue', 0, 5000);
    const visits = providers * cancels * WEEKS_PER_MONTH * Math.max(0, withSb - today);
    const recovered = visits * revenue;
    const rate = providers >= 10 ? 39 : 49;
    const cost = providers * rate;
    $('o-visits').textContent = visits.toFixed(visits < 10 ? 1 : 0);
    $('o-revenue').textContent = money(recovered);
    $('o-cost').textContent = money(cost) + ` (${providers} × $${rate})`;
    $('o-net').textContent = money(recovered - cost);
    const breakEven = revenue > 0 ? Math.ceil(cost / revenue) : Infinity;
    $('o-note').textContent = Number.isFinite(breakEven)
      ? `Slotback pays for itself once it fills ${breakEven} visit${breakEven === 1 ? '' : 's'} a month across your practice (${(breakEven / providers).toFixed(1)} per provider).`
      : 'Enter your average revenue per visit to see the break-even point.';
  }

  $('calc').addEventListener('input', update);
  $('calc').addEventListener('submit', (e) => e.preventDefault());
  update();
})();
