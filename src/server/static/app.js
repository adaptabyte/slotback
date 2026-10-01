// Progressive enhancement only: every page works without JavaScript.
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el instanceof HTMLElement && el.hasAttribute('data-autosubmit') && el.form) el.form.requestSubmit();
});

document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-confirm]') : null;
  if (el && !window.confirm(el.getAttribute('data-confirm') || 'Are you sure?')) e.preventDefault();
});

// Live-ish dashboard: refresh the "Today" and demo phone pages every 20s while visible and untouched.
if (location.pathname === '/staff' || location.pathname === '/dev/phone') {
  let dirty = false;
  document.addEventListener('input', () => (dirty = true));
  setInterval(() => {
    if (!dirty && document.visibilityState === 'visible') location.reload();
  }, 20000);
}
