const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const state = { user: null, kind: '', myOnly: false, listings: [], authMode: 'login', returnToPost: false, editingId: null };
const categories = ['Electronics', 'Keys', 'Bags', 'Clothing', 'Cards & IDs', 'Jewelry', 'Books', 'Other'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function formatDate(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(year, month - 1, day));
}

function localDateInputValue() {
  const today = new Date();
  const local = new Date(today.getTime() - today.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  $$('.auth-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.authMode === mode));
  $('#auth-title').textContent = registering ? 'Join the community.' : 'Good to have you here.';
  $('#auth-intro').textContent = registering ? 'Create an account to share and manage posts.' : 'Sign in to post an item or manage your listings.';
  $('#auth-submit').innerHTML = `${registering ? 'Create account' : 'Sign in'} <span aria-hidden="true">↗</span>`;
  $('#auth-form [name="password"]').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}

function openAuth({ returnToPost = false } = {}) {
  state.returnToPost = returnToPost;
  $('#auth-error').textContent = '';
  $('#auth-modal').showModal();
}

function openListingForm(listing = null, kind = 'found') {
  if (!state.user) return openAuth({ returnToPost: true });
  const form = $('#listing-form');
  form.reset();
  state.editingId = listing?.id ?? null;
  $('#listing-modal-title').textContent = listing ? 'Update your post' : 'Share an item';
  $('#listing-modal-eyebrow').textContent = listing ? 'Keep the community in the loop' : 'A small act of kindness';
  $('#listing-submit').innerHTML = `${listing ? 'Save changes' : 'Post to the board'} <span aria-hidden="true">↗</span>`;
  form.elements.id.value = listing?.id ?? '';
  form.elements.kind.value = listing?.kind ?? kind;
  form.elements.title.value = listing?.title ?? '';
  form.elements.category.value = listing?.category ?? '';
  form.elements.itemDate.value = listing?.itemDate ?? localDateInputValue();
  form.elements.location.value = listing?.location ?? '';
  form.elements.description.value = listing?.description ?? '';
  form.elements.contactEmail.value = listing?.contactEmail ?? state.user.email;
  $('#listing-error').textContent = '';
  $('#listing-modal').showModal();
}

function buildSearchParams() {
  const params = new URLSearchParams();
  const q = $('#search-query').value.trim();
  const category = $('#category-filter').value;
  const location = $('#location-filter').value.trim();
  if (q) params.set('q', q);
  if (state.kind) params.set('kind', state.kind);
  if (category) params.set('category', category);
  if (location) params.set('location', location);
  if (state.myOnly) params.set('status', 'all');
  return params;
}

function cardMarkup(item) {
  const kindLabel = item.kind === 'found' ? 'Found' : 'Lost';
  const status = item.status === 'resolved' ? '<span class="card-status">Resolved</span>' : '';
  return `<article class="listing-card" data-open="${item.id}" tabindex="0" role="button" aria-label="View ${escapeHtml(item.title)}">
    <div class="card-top"><span class="type-pill ${item.kind}"><span aria-hidden="true">${item.kind === 'found' ? '✦' : '○'}</span>${kindLabel} item</span><span class="card-category">${escapeHtml(item.category)}</span></div>
    <h3>${escapeHtml(item.title)}</h3><p class="card-description">${escapeHtml(item.description)}</p>
    <div class="card-meta"><span class="meta-part"><span class="meta-icon">⌖</span>${escapeHtml(item.location)}</span><span class="meta-part"><span class="meta-icon">◷</span>${escapeHtml(formatDate(item.itemDate))}</span>${status}</div>
  </article>`;
}

function emptyMarkup() {
  const hasFilters = $('#search-query').value || $('#category-filter').value || $('#location-filter').value || state.kind;
  return `<div class="empty-state"><span class="empty-icon">${hasFilters ? '⌕' : '✿'}</span><h3>${hasFilters ? 'No items found just yet.' : 'The board is ready for its first post.'}</h3><p>${hasFilters ? 'Try another search or clear the filters. New posts are added by our community.' : 'If you’ve lost something or found something, a quick post can help it find its way home.'}</p><button class="button button-primary" data-empty-action>${hasFilters ? 'Clear filters' : 'Post an item'} <span aria-hidden="true">↗</span></button></div>`;
}

async function loadListings() {
  const grid = $('#listing-grid');
  grid.innerHTML = '<div class="empty-state"><span class="empty-icon">…</span><h3>Looking around the board</h3><p>One moment while we gather the latest posts.</p></div>';
  try {
    const data = await request(`/api/listings?${buildSearchParams()}`);
    state.listings = state.myOnly ? data.listings.filter(item => item.isOwner) : data.listings;
    grid.innerHTML = state.listings.length ? state.listings.map(cardMarkup).join('') : emptyMarkup();
    $('#listing-count').textContent = state.myOnly ? `${state.listings.length} of your posts` : `${state.listings.length} ${state.listings.length === 1 ? 'post' : 'posts'} on the board`;
    $('#all-count').textContent = `· ${state.listings.length}`;
  } catch (error) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">!</span><h3>We couldn’t load the board.</h3><p>${escapeHtml(error.message)}</p><button class="button button-primary" data-retry>Try again</button></div>`;
    $('#listing-count').textContent = '';
  }
}

function openDetails(id) {
  const item = state.listings.find(listing => listing.id === Number(id));
  if (!item) return;
  const kindLabel = item.kind === 'found' ? 'Found item' : 'Lost item';
  const ownActions = item.isOwner ? `<div class="owner-actions"><button class="button button-outline" data-edit="${item.id}">Edit post</button><button class="button button-outline" data-resolve="${item.id}" data-status="${item.status}">${item.status === 'resolved' ? 'Reopen post' : 'Mark resolved'}</button><button class="button button-outline" data-delete="${item.id}">Delete</button></div>` : '';
  $('#detail-content').innerHTML = `<span class="type-pill ${item.kind} detail-type">${item.kind === 'found' ? '✦' : '○'} ${kindLabel}</span><h2 id="detail-title">${escapeHtml(item.title)}</h2><div class="detail-location"><span>⌖</span>${escapeHtml(item.location)}</div><p class="detail-description">${escapeHtml(item.description)}</p><div class="detail-facts"><div class="detail-fact"><small>Category</small><span>${escapeHtml(item.category)}</span></div><div class="detail-fact"><small>${item.kind === 'found' ? 'Found on' : 'Lost on'}</small><span>${escapeHtml(formatDate(item.itemDate))}</span></div><div class="detail-fact"><small>Post status</small><span>${item.status === 'resolved' ? 'Resolved' : 'Open'}</span></div></div><div class="contact-box"><div><small>Reach out to the person who posted</small><a href="mailto:${encodeURIComponent(item.contactEmail)}">${escapeHtml(item.contactEmail)}</a></div><a class="button button-primary" href="mailto:${encodeURIComponent(item.contactEmail)}" aria-label="Email ${escapeHtml(item.contactEmail)}">Email <span aria-hidden="true">↗</span></a></div>${ownActions}`;
  $('#detail-modal').showModal();
}

function refreshHeader() {
  const accountButton = $('#account-button');
  if (state.user) {
    accountButton.textContent = 'Sign out';
    $('#account-email').textContent = state.user.email;
    $('#account-email').classList.remove('hidden');
    $('#my-posts-button').classList.remove('hidden');
    $('#my-posts-button').textContent = state.myOnly ? 'All posts' : 'My posts';
  } else {
    accountButton.textContent = 'Sign in';
    $('#account-email').classList.add('hidden');
    $('#my-posts-button').classList.add('hidden');
    state.myOnly = false;
  }
}

$('#search-form').addEventListener('submit', event => { event.preventDefault(); loadListings(); });
$('#category-filter').addEventListener('change', loadListings);
$('#location-filter').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadListings(); } });
$$('.filter-tab').forEach(tab => tab.addEventListener('click', () => {
  state.kind = tab.dataset.kind;
  $$('.filter-tab').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
  loadListings();
}));
$('#clear-filters').addEventListener('click', () => {
  $('#search-query').value = '';
  $('#category-filter').value = '';
  $('#location-filter').value = '';
  state.kind = '';
  $$('.filter-tab').forEach(tab => { const active = !tab.dataset.kind; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
  loadListings();
});

$('#listing-grid').addEventListener('click', event => {
  const card = event.target.closest('[data-open]');
  if (card) openDetails(card.dataset.open);
  if (event.target.closest('[data-empty-action]')) {
    if ($('#search-query').value || $('#category-filter').value || $('#location-filter').value || state.kind) $('#clear-filters').click();
    else openListingForm();
  }
  if (event.target.closest('[data-retry]')) loadListings();
});
$('#listing-grid').addEventListener('keydown', event => { const card = event.target.closest('[data-open]'); if (card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openDetails(card.dataset.open); } });

function goToBrowse() { $('#browse').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#search-query').focus({ preventScroll: true }); }
$('#hero-search-button').addEventListener('click', goToBrowse);
$('#hero-post-button').addEventListener('click', () => openListingForm(null, 'found'));
$('#post-button').addEventListener('click', () => openListingForm());
$('#closing-post-button').addEventListener('click', () => openListingForm(null, 'found'));
$('#account-button').addEventListener('click', async () => {
  if (!state.user) return openAuth();
  try { await request('/api/logout', { method: 'POST', body: '{}' }); state.user = null; refreshHeader(); await loadListings(); showToast('You’ve signed out. See you again soon!'); }
  catch (error) { showToast(error.message); }
});
$('#my-posts-button').addEventListener('click', () => { state.myOnly = !state.myOnly; refreshHeader(); goToBrowse(); loadListings(); });

$$('.auth-tab').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#auth-submit');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(form));
    const data = await request(state.authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(values) });
    state.user = data.user;
    refreshHeader();
    $('#auth-modal').close();
    form.reset();
    showToast(state.authMode === 'register' ? 'Welcome! Your account is ready.' : 'Welcome back!');
    if (state.returnToPost) { state.returnToPost = false; openListingForm(); }
    await loadListings();
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#listing-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#listing-submit');
  button.disabled = true;
  $('#listing-error').textContent = '';
  const values = Object.fromEntries(new FormData(form));
  const id = state.editingId;
  delete values.id;
  try {
    await request(id ? `/api/listings/${id}` : '/api/listings', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(values) });
    $('#listing-modal').close();
    state.myOnly = false;
    refreshHeader();
    await loadListings();
    showToast(id ? 'Your post has been updated.' : 'Your post is now on the board.');
  } catch (error) { $('#listing-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#detail-content').addEventListener('click', async event => {
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    const item = state.listings.find(listing => listing.id === Number(editButton.dataset.edit));
    $('#detail-modal').close();
    if (item) openListingForm(item);
    return;
  }
  const resolveButton = event.target.closest('[data-resolve]');
  if (resolveButton) {
    const id = resolveButton.dataset.resolve;
    const status = resolveButton.dataset.status === 'resolved' ? 'open' : 'resolved';
    try { await request(`/api/listings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); $('#detail-modal').close(); await loadListings(); showToast(status === 'resolved' ? 'Marked as resolved. Thanks for the update!' : 'Your post is open again.'); }
    catch (error) { showToast(error.message); }
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    if (!window.confirm('Delete this post? This can’t be undone.')) return;
    try { await request(`/api/listings/${deleteButton.dataset.delete}`, { method: 'DELETE' }); $('#detail-modal').close(); await loadListings(); showToast('Your post has been deleted.'); }
    catch (error) { showToast(error.message); }
  }
});

$$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$$('.modal').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) modal.close(); }));

try {
  const data = await request('/api/me');
  state.user = data.user;
  refreshHeader();
} catch { /* Browsing stays available if account lookup is temporarily unavailable. */ }
loadListings();
