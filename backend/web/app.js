// Price-comparison UI. Reads the mock pricing service: GET /v1/price-comparison and GET /v1/medications.
const form = document.getElementById('search-form');
const input = document.getElementById('medicine');
const listbox = document.getElementById('suggestions');
const results = document.getElementById('results');

const money = (cents) => '$' + (cents / 100).toFixed(2);
const perDay = (cents) => (cents < 100 ? cents.toFixed(1) + '¢' : '$' + (cents / 100).toFixed(2)) + '/day';
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { medication: '', strength: null };
let suggestions = [];
let active = -1;

/* ---- suggestions ---------------------------------------------------- */
const closeSuggestions = () => {
  listbox.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  active = -1;
};

function renderSuggestions(items) {
  suggestions = items;
  if (!items.length) return closeSuggestions();
  listbox.innerHTML = items
    .map((m, i) => `<li role="option" id="sug-${i}" aria-selected="false" data-name="${esc(m.name)}">
      <strong>${esc(m.name)}</strong><em>${esc(m.strengths.slice(0, 4).join(' · '))}${m.strengths.length > 4 ? ' …' : ''}</em></li>`)
    .join('');
  listbox.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function highlight(index) {
  const items = [...listbox.querySelectorAll('li')];
  items.forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
  active = index;
  input.setAttribute('aria-activedescendant', index >= 0 ? `sug-${index}` : '');
}

let debounce;
input.addEventListener('input', () => {
  clearTimeout(debounce);
  const q = input.value.trim();
  if (q.length < 2) return closeSuggestions();
  debounce = setTimeout(async () => {
    try {
      const response = await fetch(`/v1/medications?q=${encodeURIComponent(q)}`);
      if (!response.ok) return closeSuggestions();
      renderSuggestions((await response.json()).items);
    } catch { closeSuggestions(); }
  }, 130);
});

input.addEventListener('keydown', (event) => {
  if (listbox.hidden) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); highlight((active + 1) % suggestions.length); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); highlight((active - 1 + suggestions.length) % suggestions.length); }
  else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(suggestions[active].name); }
  else if (event.key === 'Escape') closeSuggestions();
});

listbox.addEventListener('mousedown', (event) => {
  const li = event.target.closest('li');
  if (li) { event.preventDefault(); choose(li.dataset.name); }
});
document.addEventListener('click', (event) => { if (!event.target.closest('.script__field')) closeSuggestions(); });

function choose(name) {
  input.value = name;
  closeSuggestions();
  load(name, null);
}

/* ---- search --------------------------------------------------------- */
form.addEventListener('submit', (event) => {
  event.preventDefault();
  closeSuggestions();
  const value = input.value.trim();
  if (value) load(value, null);
});

document.querySelectorAll('.seed').forEach((button) =>
  button.addEventListener('click', () => { input.value = button.dataset.seed; choose(button.dataset.seed); }));

async function load(medication, strength) {
  state = { medication, strength };
  results.innerHTML = '<p class="state">Pulling prices from four pharmacies…</p>';
  const url = new URL('/v1/price-comparison', location.origin);
  url.searchParams.set('medication', medication);
  if (strength) url.searchParams.set('strength', strength);
  history.replaceState(null, '', '?' + url.searchParams.toString());
  let body;
  try {
    const response = await fetch(url);
    body = await response.json();
    if (response.status === 404) {
      results.innerHTML = `<p class="state state--error">No pricing on file for “${esc(medication)}”. Try another generic name.</p>`;
      return;
    }
    if (!response.ok) throw new Error(body.error || 'request_failed');
  } catch (error) {
    results.innerHTML = `<p class="state state--error">The pricing service did not answer (${esc(error.message)}). Is <code>npm run web</code> still running?</p>`;
    return;
  }
  render(body);
}

/* ---- render --------------------------------------------------------- */
function render(data) {
  const med = data.medication;
  const suppliers = [...data.suppliers].sort((a, b) => a.quotes[0].price_cents - b.quotes[0].price_cents);
  const best = data.best_value;
  const winners = data.best_by_days_supply;
  const bestSupplier = suppliers.find((s) => s.source === best?.source);
  const bestQuote = bestSupplier?.quotes.find((q) => q.days_supply === best.days_supply);

  const strengthButtons = data.available_strengths
    .map((s) => `<button type="button" data-strength="${esc(s)}" aria-pressed="${s === med.strength}">${esc(s)}</button>`)
    .join('');

  const cards = suppliers.map((supplier, index) => {
    const isBest = supplier.source === best?.source;
    const rows = supplier.quotes.map((quote) => {
      const wins = winners[quote.days_supply]?.source === supplier.source;
      return `
      <li>
        <a class="row ${wins ? 'row--cheapest' : ''}"
           href="${esc(quote.purchase_url)}" target="_blank" rel="noopener noreferrer"
           title="${esc(quote.pricing_basis)}">
          <span class="row__term"><b>${quote.days_supply}-day</b></span>
          <span class="row__leader"></span>
          <span class="row__price">${money(quote.price_cents)}</span>
          <span class="row__go">Buy ↗</span>
          <span class="row__sub">${quote.quantity} ${esc(quote.unit)}s${quote.fills > 1 ? ` · ${quote.fills} fills` : ''} · ${perDay(quote.price_per_day_cents)}${wins ? ` · <b>cheapest ${quote.days_supply}-day</b>` : ''}</span>
        </a>
      </li>`;
    }).join('');
    return `
      <article class="pharmacy ${isBest ? 'pharmacy--best' : ''}" style="animation-delay:${0.08 + index * 0.06}s">
        <div class="pharmacy__head">
          <div>
            <h3 class="pharmacy__name">${esc(supplier.source_name)}</h3>
            <p class="pharmacy__mode">${esc(supplier.fulfilment)}</p>
          </div>
          ${isBest ? '<span class="pharmacy__stamp">Lowest per day</span>' : ''}
        </div>
        <ul class="rows">${rows}</ul>
        <p class="pharmacy__note">${esc(supplier.note)}<br><span class="pharmacy__link">Links open the ${esc(supplier.link_target)}.</span></p>
      </article>`;
  }).join('');

  results.innerHTML = `
    <section class="dossier">
      <div class="dossier__head">
        <div>
          <h2 class="dossier__name">${esc(med.name)} <em>${esc(med.strength)}</em></h2>
          <p class="dossier__meta">${esc(med.form)} · ${med.doses_per_day}× daily${med.brand_name ? ` · brand ${esc(med.brand_name)}` : ''}</p>
        </div>
        <div class="strengths"><span class="strengths__label">Strength</span>${strengthButtons}</div>
      </div>
      ${bestQuote ? `
      <div class="headline">
        <span class="headline__tag">Best value</span>
        <p class="headline__body"><b>${esc(bestSupplier.source_name)}</b> at ${money(bestQuote.price_cents)} for a
          ${bestQuote.days_supply}-day supply — ${perDay(bestQuote.price_per_day_cents)}.</p>
        <a href="${esc(bestQuote.purchase_url)}" target="_blank" rel="noopener noreferrer">Open ${esc(bestSupplier.source_name)} ↗</a>
      </div>` : ''}
      <div class="ledger">${cards}</div>
      <p class="footnote">Quoted ${new Date(data.as_of).toLocaleString()} · source: ${esc(data.data_source)} pricing service ·
        every price links straight to that pharmacy's page for this medication.</p>
    </section>`;

  results.querySelectorAll('.strengths button').forEach((button) =>
    button.addEventListener('click', () => load(state.medication, button.dataset.strength)));
}

/* ---- deep link ------------------------------------------------------ */
const initial = new URLSearchParams(location.search);
if (initial.get('medication')) {
  input.value = initial.get('medication');
  load(initial.get('medication'), initial.get('strength'));
}
