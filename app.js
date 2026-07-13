(() => {
  const CART_KEY = 'brilliantOrderCartV1';
  const ORDERING_ENABLED = false;

  const qs = (s, p = document) => p.querySelector(s);
  const qsa = (s, p = document) => Array.from(p.querySelectorAll(s));

  function normalizeText(value) {
    return String(value || '')
      .toLocaleLowerCase('ru-RU')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function formatMoney(value) {
    return `${Number(value || 0).toLocaleString('ru-RU')} ₸`;
  }

  function parsePrice(value) {
    return Number(String(value || '').replace(/[^\d]/g, '')) || 0;
  }

  function makeId(value) {
    return normalizeText(value)
      .replace(/[^a-zа-яё0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function initCardDetails() {
    const staggerGroups = [
      qsa('.category-grid .category-card'),
      qsa('.product-grid .product-card')
    ];

    staggerGroups.forEach(group => {
      group.forEach((item, index) => {
        if (!item.style.getPropertyValue('--delay')) {
          item.style.setProperty('--delay', `${Math.min(index * 45, 840)}ms`);
        }
        item.style.setProperty('--card-index', index);
      });
    });

    qsa('.product-card__image-wrap img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src.includes('placeholders-') || src.includes('no-photo')) {
        img.closest('.product-card__image-wrap')?.classList.add('product-card__image-wrap--placeholder');
      }
    });
  }

  initCardDetails();

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  qsa('.reveal').forEach(el => observer.observe(el));

  function initMenuSearch() {
    const input = qs('#menuSearch');
    if (!input) return;

    const items = qsa('.category-card, .product-card');
    const empty = qs('#menuEmpty');
    if (!items.length) return;

    input.value = '';

    function applyFilter() {
      const query = normalizeText(input.value);
      let visibleCount = 0;

      items.forEach((item, index) => {
        const text = normalizeText(item.dataset.search || item.textContent);
        const isVisible = !query || text.includes(query);
        window.clearTimeout(item.filterTimer);
        item.style.setProperty('--filter-delay', `${Math.min(index * 18, 150)}ms`);

        if (isVisible) {
          item.hidden = false;
          item.classList.remove('is-filtered-out');
          window.requestAnimationFrame(() => item.classList.remove('is-filtering-out'));
          visibleCount += 1;
          return;
        }

        item.classList.add('is-filtering-out', 'is-filtered-out');
        item.filterTimer = window.setTimeout(() => {
          item.hidden = true;
        }, 230);
      });

      if (empty) empty.hidden = visibleCount > 0;
    }

    input.addEventListener('input', applyFilter);
    input.addEventListener('search', applyFilter);
    input.addEventListener('change', applyFilter);
    applyFilter();
  }

  function getCart() {
    return readJson(CART_KEY, []);
  }

  function setCart(cart) {
    writeJson(CART_KEY, cart);
    window.dispatchEvent(new CustomEvent('brilliant:cart-change'));
  }

  function getCartTotal(cart = getCart()) {
    return cart.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 0), 0);
  }

  function getCartCount(cart = getCart()) {
    return cart.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  }

  function getCurrentCategory() {
    return qs('.breadcrumbs strong')?.textContent?.trim()
      || qs('.section-heading h1')?.textContent?.trim()
      || 'Меню';
  }

  function getProductFromCard(card) {
    const name = qs('h3', card)?.textContent?.trim() || 'Блюдо';
    const desc = qs('.product-card__desc', card)?.textContent?.trim() || '';
    const priceText = qs('.price', card)?.textContent?.trim() || '0';
    const price = parsePrice(priceText);
    const category = getCurrentCategory();

    return {
      id: makeId(`${category}-${name}-${price}`),
      name,
      desc,
      price,
      category
    };
  }

  function addToCart(product) {
    const cart = getCart();
    const existing = cart.find(item => item.id === product.id);

    if (existing) {
      existing.qty += 1;
    } else {
      cart.push({ ...product, qty: 1 });
    }

    setCart(cart);
    showOrderToast(`${product.name} добавлено в заказ`);
  }

  function updateCartQty(id, qty) {
    const cart = getCart()
      .map(item => item.id === id ? { ...item, qty: Math.max(0, Number(qty) || 0) } : item)
      .filter(item => item.qty > 0);

    setCart(cart);
  }

  function clearCart() {
    setCart([]);
  }

  function addProductButtons() {
    qsa('.product-card').forEach(card => {
      if (card.dataset.orderReady === 'true') return;

      const footer = qs('.product-card__footer', card);
      const price = qs('.price', card);
      if (!footer || !price) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'order-add-btn';
      button.textContent = 'В заказ';
      button.addEventListener('click', () => addToCart(getProductFromCard(card)));

      footer.classList.add('product-card__footer--order');
      footer.appendChild(button);
      card.dataset.orderReady = 'true';
    });
  }

  function ensureCartShell() {
    if (qs('#orderDrawer')) return;

    document.body.insertAdjacentHTML('beforeend', `
      <button class="order-float" id="orderFloat" type="button" aria-label="Открыть заказ">
        <span class="order-float__label">Заказ</span>
        <span class="order-float__count" id="orderFloatCount">0</span>
      </button>
      <div class="order-backdrop" id="orderBackdrop" hidden></div>
      <aside class="order-drawer" id="orderDrawer" aria-label="Ваш заказ" aria-hidden="true">
        <div class="order-drawer__head">
          <div>
            <p class="eyebrow">BRILLIANT ORDER</p>
            <h2>Ваш заказ</h2>
          </div>
          <button class="order-icon-btn" id="orderClose" type="button" aria-label="Закрыть">×</button>
        </div>
        <div class="order-drawer__body">
          <div class="order-list" id="orderList"></div>
          <form class="order-form" id="orderForm">
            <label class="order-field">
              <span>Столик</span>
              <input id="orderTable" name="table" type="text" inputmode="numeric" placeholder="Например: 7" autocomplete="off" required>
            </label>
            <div class="order-total">
              <span>Итого</span>
              <strong id="orderTotal">0 ₸</strong>
            </div>
            <button class="order-submit" id="orderSubmit" type="submit">Отправить заказ</button>
            <p class="order-note" id="orderStatus" role="status"></p>
          </form>
        </div>
      </aside>
    `);
  }

  function setDrawerOpen(isOpen) {
    const drawer = qs('#orderDrawer');
    const backdrop = qs('#orderBackdrop');
    if (!drawer || !backdrop) return;

    drawer.classList.toggle('is-open', isOpen);
    drawer.setAttribute('aria-hidden', String(!isOpen));
    backdrop.hidden = !isOpen;
    document.body.classList.toggle('has-order-drawer', isOpen);
  }

  function renderCart() {
    const cart = getCart();
    const list = qs('#orderList');
    const total = qs('#orderTotal');
    const floatCount = qs('#orderFloatCount');
    const floatButton = qs('#orderFloat');
    const submit = qs('#orderSubmit');
    const count = getCartCount(cart);

    if (floatCount) floatCount.textContent = String(count);
    if (floatButton) {
      const hasProducts = qsa('.product-card').length > 0;
      floatButton.classList.toggle('is-visible', count > 0 || hasProducts);
      floatButton.querySelector('.order-float__label').textContent = count > 0 ? formatMoney(getCartTotal(cart)) : 'Заказ';
    }
    if (total) total.textContent = formatMoney(getCartTotal(cart));
    if (submit) submit.disabled = count === 0;
    if (!list) return;

    if (!cart.length) {
      list.innerHTML = '<div class="order-empty">Пока заказ пуст. Выберите блюдо из меню.</div>';
      return;
    }

    list.innerHTML = cart.map(item => `
      <div class="order-line" data-id="${escapeHtml(item.id)}">
        <div class="order-line__main">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.category)}</span>
          <small>${formatMoney(item.price)}</small>
        </div>
        <div class="order-line__controls">
          <button type="button" class="order-qty-btn" data-action="minus" aria-label="Уменьшить">−</button>
          <span>${item.qty}</span>
          <button type="button" class="order-qty-btn" data-action="plus" aria-label="Увеличить">+</button>
        </div>
      </div>
    `).join('');
  }

  function setOrderStatus(message, tone = '') {
    const status = qs('#orderStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function showOrderToast(message) {
    let toast = qs('#orderToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'orderToast';
      toast.className = 'order-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(showOrderToast.timer);
    showOrderToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
  }

  async function postOrder(payload) {
    let response;

    try {
      response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch {
      throw new Error('Сервер қосылмаған. Telegram-ға жіберу үшін server.js іске қосылуы керек.');
    }

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const defaultError = response.status === 404
        ? 'Telegram сервері қосылмаған. server.js іске қосыңыз.'
        : 'Заказ жіберілмеді.';
      throw new Error(data.error || defaultError);
    }

    if (!data.telegram?.sent) {
      throw new Error(data.telegram?.error || 'Telegram бапталмаған. BOT_TOKEN және CHAT_ID тексеріңіз.');
    }

    return data.order;
  }

  function buildOrderPayload() {
    const cart = getCart();

    return {
      table: qs('#orderTable')?.value?.trim() || '',
      items: cart.map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        price: item.price,
        qty: item.qty
      })),
      total: getCartTotal(cart)
    };
  }

  async function submitOrder(event) {
    event.preventDefault();

    const payload = buildOrderPayload();
    const submit = qs('#orderSubmit');

    if (!payload.items.length) {
      setOrderStatus('Заказ пустой.', 'error');
      return;
    }

    if (!payload.table) {
      setOrderStatus('Столик нөмірін жазыңыз.', 'error');
      qs('#orderTable')?.focus();
      return;
    }

    if (submit) submit.disabled = true;
    setOrderStatus('Заказ Telegram-ға жіберіліп жатыр...');

    try {
      const order = await postOrder(payload);
      clearCart();
      setOrderStatus(`Заказ ${order.id} Telegram-ға жіберілді.`, 'success');
      showOrderToast('Заказ Telegram-ға жіберілді');
    } catch (error) {
      setOrderStatus(error.message || 'Заказ жіберілмеді.', 'error');
    } finally {
      renderCart();
    }
  }

  function initCustomerOrdering() {
    if (!ORDERING_ENABLED) return;

    addProductButtons();
    ensureCartShell();
    renderCart();

    qs('#orderFloat')?.addEventListener('click', () => setDrawerOpen(true));
    qs('#orderClose')?.addEventListener('click', () => setDrawerOpen(false));
    qs('#orderBackdrop')?.addEventListener('click', () => setDrawerOpen(false));
    qs('#orderForm')?.addEventListener('submit', submitOrder);
    qs('#orderList')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;

      const line = button.closest('.order-line');
      const id = line?.dataset.id;
      const item = getCart().find(cartItem => cartItem.id === id);
      if (!item) return;

      updateCartQty(id, button.dataset.action === 'plus' ? item.qty + 1 : item.qty - 1);
    });

    window.addEventListener('brilliant:cart-change', renderCart);
  }

  initMenuSearch();
  initCustomerOrdering();
})();
