/* ==========================================================================
   Mi Minimarket — Sistema Dual Automático (PC 16:9 y Teléfono 9:16)
   - En Vender: Solo lupa limpia (sin mostrar productos hasta que busque)
   - Limitador estricto anti-números negativos y anti-sobrecupo de stock
   - En Cargar: Asistente Paso a Paso (1. Escanear -> 2. Nombre -> 3. Valor)
   ========================================================================== */

let scannerMode = "sale"; // "sale" (vender) o "edit" (cargar paso a paso)
let activeNavScreen = "escanear"; // "escanear" (Vender), "stock", "editar" (Cargar), "comprar" (Resumen)

// Estado del Asistente Paso a Paso ("Cargar")
let wizardState = {
  step: 1,
  barcode: "",
  name: "",
  brand: "",
  category: "Abarrotes",
  emoji: "🍚",
  image: "",
  stock: 12,
  price: "",
  isExistingInStore: false,
};

// Cámara y Lector Real
let cameraStream = null;
let scanLoopActive = false;
let zxingReader = null;
let torchOn = false;
let lastScannedCode = "";
let lastScannedTime = 0;

let bannerTimeout = null;

// =========================================================================
// DETECCIÓN AUTOMÁTICA DE POSICIÓN (16:9 HORIZONTAL PC vs 9:16 VERTICAL TELÉFONO)
// =========================================================================
function detectDevicePosition() {
  const w = window.innerWidth || document.documentElement.clientWidth;
  const h = window.innerHeight || document.documentElement.clientHeight;
  const isHorizontalOrPC = w > h || w >= 720;

  document.body.classList.toggle("is-pc-16-9", isHorizontalOrPC);
  document.body.classList.toggle("is-phone-9-16", !isHorizontalOrPC);

  // Mover el asistente Paso a Paso al contenedor activo (PC o Teléfono)
  const wizardEl = document.getElementById("stepWizardContainer");
  const pcMount = document.getElementById("pcWizardMount");
  const mobMount = document.getElementById("mobWizardMount");
  if (wizardEl && pcMount && mobMount) {
    const targetMount = isHorizontalOrPC ? pcMount : mobMount;
    if (wizardEl.parentElement !== targetMount) {
      targetMount.appendChild(wizardEl);
    }
  }
}

window.addEventListener("resize", detectDevicePosition);
window.addEventListener("orientationchange", detectDevicePosition);

function formatPrice(num) {
  return "$" + Math.max(0, Number(num || 0)).toLocaleString("es-CL");
}

function formatRelativeTime(timestamp) {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return "Recién cobrado";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Hace ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Hace ${diffHours} h`;
  const d = new Date(timestamp);
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "short" });
}

function playScannerBeep(isError = false) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(isError ? [120, 60, 120] : 70);
    } catch (_) {}
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = isError ? "sawtooth" : "sine";
    osc.frequency.setValueAtTime(isError ? 320 : 1180, ctx.currentTime);
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (isError ? 0.28 : 0.14));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (isError ? 0.3 : 0.15));
  } catch (_) {}
}

function showFeedback(text, isWarning = false) {
  const banner = document.getElementById("feedbackBanner");
  banner.textContent = text;
  banner.classList.toggle("warning", Boolean(isWarning));
  banner.hidden = false;
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.hidden = true;
  }, 3800);
}

function getStockStatus(p) {
  if (p.stock <= 0) {
    return { code: "out", cardClass: "out-stock", label: "🔴 Se acabó (0)" };
  }
  if (p.stock <= p.minStock) {
    return { code: "low", cardClass: "low-stock", label: "🟡 Quedan pocos" };
  }
  return { code: "ok", cardClass: "", label: "🟢 Bien de stock" };
}

function renderProductThumbHTML(p, sizePx = 64) {
  if (p.image) {
    return `<img src="${p.image}" alt="${p.name}" class="item-thumb-img" style="width:${sizePx}px;height:${sizePx}px;" loading="lazy" onerror="this.style.display='none'" />`;
  }
  return `<div class="item-emoji" style="width:${sizePx}px;height:${sizePx}px;" aria-hidden="true">${p.emoji || "📦"}</div>`;
}

// Evitar cualquier número negativo en un input numérico
function sanitizeNonNegativeInput(inputEl) {
  if (!inputEl) return 0;
  const cleaned = String(inputEl.value).replace(/[^0-9]/g, "");
  const val = cleaned === "" ? 0 : Math.max(0, parseInt(cleaned, 10) || 0);
  if (Number(inputEl.value) < 0) inputEl.value = val;
  return val;
}

// =========================================================================
// MOTOR DE RECOMENDACIÓN INTELIGENTE DE COMPRA (RESUMEN DEL MES)
// =========================================================================
function calculateSmartRestock(p) {
  const dailyRate = p.soldMonth / 30;
  const targetDays = p.perishable ? 8 : 14;
  const safetyMultiplier = p.perishable ? 1.15 : 1.2;

  const idealStock = Math.max(
    p.perishable ? 4 : 6,
    Math.ceil(dailyRate * targetDays * safetyMultiplier)
  );

  const recommendedToBuy = Math.max(0, idealStock - p.stock);

  let priorityCode = "careful";
  let priorityLabel = "🐢 VENTA LENTA — COMPRAR POQUITO";
  let cardClass = "";
  let explanation = "";

  if (p.soldMonth >= 35 && p.stock <= p.minStock) {
    priorityCode = "urgent";
    cardClass = "priority-urgent";
    priorityLabel = "🔥 SE VENDE MUCHO Y QUEDA POCO";
  } else if (p.soldMonth >= 20) {
    priorityCode = "high";
    cardClass = "priority-high";
    priorityLabel = "⭐ BUENA VENTA EN EL MES";
  }

  if (p.perishable) {
    explanation = `Se vendieron ${p.soldMonth} en el mes. Como puede vencer, te recomendamos comprar ${recommendedToBuy} u. (alcanza para ~${targetDays} días con margen sin que se venza).`;
  } else if (p.soldMonth < 12) {
    explanation = `Sale lento (${p.soldMonth} vendidos en el mes). Te recomendamos comprar solo ${recommendedToBuy} u. para no acumular mercadería de más.`;
  } else {
    explanation = `Muy pedido (${p.soldMonth} vendidos este mes). Con ${recommendedToBuy} u. cubres 2 semanas de venta más un margen seguro.`;
  }

  const urgencyScore = p.soldMonth * 2 - p.stock * 5;

  return {
    product: p,
    idealStock,
    recommendedToBuy,
    priorityCode,
    priorityLabel,
    cardClass,
    explanation,
    urgencyScore,
  };
}

// =========================================================================
// CARRITO CON LIMITADOR ESTRICTO DE STOCK (PROHIBIDO QUEDAR EN NEGATIVO)
// =========================================================================
async function addProductToCart(barcode) {
  const cleanCode = String(barcode).trim();
  const result = await window.minimarketDB.addToCart(cleanCode, 1);

  if (result.error === "NOT_FOUND") {
    playScannerBeep(true);
    closeModal("cameraModal");
    switchScreen("editar");
    await startWizardWithBarcode(cleanCode);
    showFeedback("🆕 Producto no registrado aún: cárgalo en estos 3 pasos", true);
    return;
  }

  if (result.error === "OUT_OF_STOCK") {
    playScannerBeep(true);
    const pName = result.product ? result.product.name : "este producto";
    showFeedback(`⛔ No queda stock de "${pName}" (0 disponibles). No se puede vender.`, true);
    const liveCamBox = document.getElementById("cameraLiveScanned");
    if (!document.getElementById("cameraModal").hidden) {
      liveCamBox.hidden = false;
      liveCamBox.textContent = `⛔ Sin stock: ${pName} (0 disponibles)`;
    }
    return;
  }

  if (result.error === "MAX_STOCK_REACHED") {
    playScannerBeep(true);
    const pName = result.product ? result.product.name : "este producto";
    showFeedback(
      `⚠️ Límite de stock: Solo queda(n) ${result.available} u. de "${pName}" y ya tienes ${result.inCart} en la cuenta.`,
      true
    );
    const liveCamBox = document.getElementById("cameraLiveScanned");
    if (!document.getElementById("cameraModal").hidden) {
      liveCamBox.hidden = false;
      liveCamBox.textContent = `⚠️ Máximo alcanzado: Solo hay ${result.available} u. de ${pName}`;
    }
    return;
  }

  // Éxito al agregar al carrito
  playScannerBeep(false);
  const prod = result.product;
  const remainingAfterCart = Math.max(0, prod.stock - result.inCart);

  // Actualizar cartel último escaneado en Teléfono y PC
  const lastBox = document.getElementById("lastScannedBox");
  lastBox.hidden = false;
  document.getElementById("lastScannedName").textContent = `${prod.emoji} ${prod.name}`;
  document.getElementById("lastScannedPrice").textContent = formatPrice(prod.price);
  document.getElementById("lastScannedStock").textContent = `En cuenta: ${result.inCart} · Quedan ${remainingAfterCart} libres`;

  const pcLastBox = document.getElementById("pcLastScannedBox");
  pcLastBox.hidden = false;
  document.getElementById("pcLastScannedName").textContent = `${prod.emoji} ${prod.name}`;
  document.getElementById("pcLastScannedPrice").textContent = formatPrice(prod.price);
  document.getElementById("pcLastScannedStock").textContent = `En cuenta: ${result.inCart} · Quedan ${remainingAfterCart} disponibles`;

  const liveCamBox = document.getElementById("cameraLiveScanned");
  if (!document.getElementById("cameraModal").hidden) {
    liveCamBox.hidden = false;
    liveCamBox.textContent = `✅ Sumado (${result.inCart} de ${prod.stock}): ${prod.name} → ${formatPrice(prod.price)}`;
  }

  renderAll();
  showFeedback(`🛒 Agregado: ${prod.name} → ${formatPrice(prod.price)}`);
}

async function confirmEntireCartSale() {
  const sale = await window.minimarketDB.checkoutCart();
  if (!sale) return;

  document.getElementById("lastScannedBox").hidden = true;
  document.getElementById("pcLastScannedBox").hidden = true;
  renderAll();
  showFeedback(`✅ Venta confirmada: Cobraste ${formatPrice(sale.totalPrice)} (${sale.totalQty} prod.)`);
}

async function handleUndoLastSale() {
  const undone = await window.minimarketDB.undoLastSale();
  if (!undone) return;
  renderAll();
  showFeedback(`↩️ Venta anulada (${formatPrice(undone.totalPrice)}). Se devolvió el stock.`);
}

// =========================================================================
// LUPA DE BÚSQUEDA LIMPIA EN "VENDER" (SOLO MUESTRA RESULTADOS SI ESCRIBE)
// =========================================================================
function renderPosSearchResults(inputId, resultsContainerId, clearBtnId) {
  const inputEl = document.getElementById(inputId);
  const resultsEl = document.getElementById(resultsContainerId);
  const clearBtn = document.getElementById(clearBtnId);
  if (!inputEl || !resultsEl) return;

  const query = (inputEl.value || "").toLowerCase().trim();
  if (clearBtn) clearBtn.hidden = !query;

  // Si no ha escrito nada en la lupa, NO mostrar ningún producto para no ser invasivo
  if (!query) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }

  const products = window.minimarketDB.getAllProductsWithStats();
  const matches = products
    .filter((p) =>
      window.ChileCatalog && window.ChileCatalog.fuzzyMatch
        ? window.ChileCatalog.fuzzyMatch(query, p.name, p.brand, p.category, p.barcode)
        : p.name.toLowerCase().includes(query) || p.barcode.includes(query)
    )
    .slice(0, 8);

  resultsEl.hidden = false;
  if (matches.length === 0) {
    resultsEl.innerHTML = `
      <div class="cart-empty-box" style="grid-column: 1 / -1; padding: 14px;">
        No se encontró "${inputEl.value}" en tu stock.
      </div>
    `;
    return;
  }

  resultsEl.innerHTML = matches
    .map(
      (p) => `
      <button type="button" class="pc-pos-prod-btn" data-sale-barcode="${p.barcode}">
        ${renderProductThumbHTML(p, 48)}
        <div class="pc-pos-prod-meta">
          <span class="pc-pos-prod-name">${p.name}</span>
          <strong class="pc-pos-prod-price">${formatPrice(p.price)}</strong>
          <span class="pc-pos-prod-stock">${p.stock > 0 ? `Disponibles: ${p.stock} u.` : "🔴 Sin stock (0)"}</span>
        </div>
      </button>
    `
    )
    .join("");
}

// =========================================================================
// ASISTENTE PASO A PASO EN "CARGAR" (1. ESCANEAR -> 2. NOMBRE -> 3. VALOR)
// =========================================================================
function goToWizardStep(stepNum) {
  wizardState.step = stepNum;

  document.getElementById("wizStep1").hidden = stepNum !== 1;
  document.getElementById("wizStep2").hidden = stepNum !== 2;
  document.getElementById("wizStep3").hidden = stepNum !== 3;

  const p1 = document.getElementById("wizPill1");
  const p2 = document.getElementById("wizPill2");
  const p3 = document.getElementById("wizPill3");

  p1.className = "wiz-step-pill " + (stepNum === 1 ? "active" : "done");
  p2.className = "wiz-step-pill " + (stepNum === 2 ? "active" : stepNum > 2 ? "done" : "");
  p3.className = "wiz-step-pill " + (stepNum === 3 ? "active" : "");

  if (stepNum === 2) {
    setTimeout(() => document.getElementById("wizNameInput").focus(), 100);
  } else if (stepNum === 3) {
    // Actualizar resumen en Paso 3
    const nameVal = document.getElementById("wizNameInput").value.trim() || "Producto";
    const stockVal = Math.max(0, Number(document.getElementById("wizStockInput").value) || 0);
    wizardState.name = nameVal;
    wizardState.stock = stockVal;

    document.getElementById("wizStep3Name").textContent = nameVal;
    document.getElementById("wizStep3Stock").textContent = `Cantidad total: ${stockVal} unidades`;

    const img3 = document.getElementById("wizStep3Img");
    const emo3 = document.getElementById("wizStep3Emoji");
    if (wizardState.image) {
      img3.src = wizardState.image;
      img3.hidden = false;
      emo3.hidden = true;
    } else {
      img3.hidden = true;
      emo3.textContent = wizardState.emoji || "📦";
      emo3.hidden = false;
    }

    document.getElementById("wizDeleteExistingBtn").hidden = !wizardState.isExistingInStore;
    setTimeout(() => document.getElementById("wizPriceInput").focus(), 100);
  }
}

function updateWizardStep2Preview() {
  const card = document.getElementById("wizRecognizedCard");
  const pill = document.getElementById("wizRecognizedPill");
  const imgEl = document.getElementById("wizPreviewImg");
  const emoEl = document.getElementById("wizPreviewEmoji");
  const titleEl = document.getElementById("wizPreviewTitle");
  const codeEl = document.getElementById("wizPreviewCode");

  if (wizardState.isExistingInStore) {
    card.classList.remove("not-found");
    pill.textContent = "📦 Producto ya guardado en tu local (Puedes actualizarlo)";
  } else if (wizardState.name) {
    card.classList.remove("not-found");
    pill.textContent = "✨ Reconocido automáticamente en base de datos de Chile";
  } else {
    card.classList.add("not-found");
    pill.textContent = "✍️ Producto nuevo: escribe su nombre abajo";
  }

  titleEl.textContent = wizardState.name || "Escribe el nombre abajo";
  codeEl.textContent = `Código: ${wizardState.barcode}`;

  if (wizardState.image) {
    imgEl.src = wizardState.image;
    imgEl.hidden = false;
    emoEl.hidden = true;
  } else {
    imgEl.hidden = true;
    emoEl.textContent = wizardState.emoji || "📦";
    emoEl.hidden = false;
  }
}

async function startWizardWithBarcode(rawBarcode) {
  const cleanCode =
    String(rawBarcode || "").trim() ||
    `780${Math.floor(1000000000 + Math.random() * 8999999999)}`;

  // 1. ¿Ya existe en el stock del minimarket?
  const existing = window.minimarketDB.findProduct(cleanCode);
  if (existing) {
    wizardState = {
      step: 2,
      barcode: existing.barcode,
      name: existing.name,
      brand: existing.brand || "",
      category: existing.category || "Abarrotes",
      emoji: existing.emoji || "📦",
      image: existing.image || "",
      stock: Math.max(0, Number(existing.stock || 0)),
      price: existing.price,
      isExistingInStore: true,
    };

    document.getElementById("wizNameInput").value = wizardState.name;
    document.getElementById("wizStockInput").value = wizardState.stock;
    document.getElementById("wizPriceInput").value = wizardState.price;
    updateWizardStep2Preview();
    goToWizardStep(2);
    return;
  }

  // 2. Si es nuevo en el local, buscarlo automáticamente en la Base de Datos de Chile
  wizardState = {
    step: 2,
    barcode: cleanCode,
    name: "Buscando producto...",
    brand: "",
    category: "Abarrotes",
    emoji: "🔍",
    image: "",
    stock: 12,
    price: "",
    isExistingInStore: false,
  };
  document.getElementById("wizNameInput").value = "";
  document.getElementById("wizStockInput").value = "12";
  document.getElementById("wizPriceInput").value = "";
  updateWizardStep2Preview();
  goToWizardStep(2);

  if (rawBarcode && window.ChileCatalog) {
    const foundChile = await window.ChileCatalog.lookupByBarcode(cleanCode);
    if (foundChile && foundChile.found) {
      wizardState.name = foundChile.name;
      wizardState.brand = foundChile.brand || "";
      wizardState.category = foundChile.category || "Abarrotes";
      wizardState.emoji = foundChile.emoji || "📦";
      wizardState.image = foundChile.image || "";

      document.getElementById("wizNameInput").value = wizardState.name;
      updateWizardStep2Preview();
      return;
    }
  }

  wizardState.name = "";
  wizardState.emoji = "📦";
  updateWizardStep2Preview();
}

function renderWizardStep1Search() {
  const input = document.getElementById("wizSearchInput");
  const resultsEl = document.getElementById("wizSearchResults");
  const clearBtn = document.getElementById("wizClearSearchBtn");
  if (!input || !resultsEl) return;

  const q = (input.value || "").toLowerCase().trim();
  if (clearBtn) clearBtn.hidden = !q;

  if (!q) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }

  // Buscar primero en los productos ya guardados del local (ignorando tildes y errores) y luego en el catálogo de Chile
  const storeMatches = window.minimarketDB
    .getAllProductsWithStats()
    .filter((p) =>
      window.ChileCatalog && window.ChileCatalog.fuzzyMatch
        ? window.ChileCatalog.fuzzyMatch(q, p.name, p.brand, p.category, p.barcode)
        : p.name.toLowerCase().includes(q) || p.barcode.includes(q)
    );

  const chileMatches = window.ChileCatalog
    ? window.ChileCatalog
        .searchSuggestions(q)
        .filter((c) => !storeMatches.some((s) => s.barcode === c.barcode))
    : [];

  const combined = [...storeMatches, ...chileMatches].slice(0, 8);
  resultsEl.hidden = false;

  if (combined.length === 0) {
    resultsEl.innerHTML = `
      <div class="cart-empty-box" style="grid-column: 1 / -1; padding: 12px;">
        No está en la lista. Toca abajo <strong>"➕ Producto sin código"</strong> para escribirlo.
      </div>
    `;
    return;
  }

  resultsEl.innerHTML = combined
    .map(
      (item) => `
      <button type="button" class="demo-chip" data-wiz-pick="${item.barcode}">
        ${item.image ? `<img src="${item.image}" alt="" class="catalog-chip-thumb" />` : `<span>${item.emoji || "📦"}</span>`}
        <span style="overflow:hidden; text-overflow:ellipsis;">${item.name}</span>
      </button>
    `
    )
    .join("");
}

// =========================================================================
// RENDERIZADO GENERAL DE LAS 4 SECCIONES
// =========================================================================
function renderAll() {
  const products = window.minimarketDB.getAllProductsWithStats();
  const saleCart = window.minimarketDB.state.cart;
  const salesHistory = window.minimarketDB.state.sales;

  // Calcular totales del carrito
  let totalCartItems = 0;
  let totalCartMoney = 0;
  saleCart.forEach((item) => {
    const prod = products.find((p) => p.barcode === item.barcode);
    if (prod) {
      totalCartItems += item.qty;
      totalCartMoney += prod.price * item.qty;
    }
  });

  // Filas del carrito con botón + bloqueado cuando alcanza el límite de stock disponible
  const cartRowsHTML =
    saleCart.length === 0
      ? `<div class="cart-empty-box">Escanea con la cámara o busca con la lupa para armar la cuenta.</div>`
      : saleCart
          .map((item) => {
            const prod = products.find((p) => p.barcode === item.barcode);
            if (!prod) return "";
            const subtotal = prod.price * item.qty;
            const atMaxStock = item.qty >= prod.stock;
            return `
              <div class="cart-item-row">
                <div class="cart-item-top">
                  <div style="display:flex; gap:10px; align-items:center;">
                    ${renderProductThumbHTML(prod, 48)}
                    <div>
                      <div class="cart-item-name">${prod.name}</div>
                      <div class="cart-item-unit">
                        Unitario: <strong>${formatPrice(prod.price)}</strong> · Máx disponible: <strong>${prod.stock} u.</strong>
                      </div>
                    </div>
                  </div>
                  <button type="button" class="cart-item-remove" data-cart-remove="${prod.barcode}">
                    ✕ Quitar
                  </button>
                </div>
                <div class="cart-item-bottom">
                  <div class="cart-qty-stepper">
                    <button type="button" class="cart-step-btn minus" data-cart-delta="-1" data-cart-code="${prod.barcode}">−</button>
                    <strong class="cart-qty-num">${item.qty}</strong>
                    <button
                      type="button"
                      class="cart-step-btn plus"
                      data-cart-delta="1"
                      data-cart-code="${prod.barcode}"
                      ${atMaxStock ? 'disabled title="No quedan más unidades en stock"' : ""}
                    >+</button>
                  </div>
                  <strong class="cart-item-subtotal">${formatPrice(subtotal)}</strong>
                </div>
              </div>
            `;
          })
          .join("");

  const cartSummaryText =
    totalCartItems === 0
      ? "Todavía no hay productos en la cuenta"
      : `${totalCartItems} ${totalCartItems === 1 ? "unidad" : "unidades"} para cobrar`;

  // Carrito Teléfono
  document.getElementById("cartItemsSummary").textContent = cartSummaryText;
  document.getElementById("cartItemsList").innerHTML = cartRowsHTML;
  document.getElementById("cartGrandTotal").textContent = formatPrice(totalCartMoney);
  document.getElementById("clearCartBtn").hidden = saleCart.length === 0;
  document.getElementById("cartCheckoutFooter").hidden = saleCart.length === 0;
  const navCartBadge = document.getElementById("navCartBadge");
  navCartBadge.textContent = totalCartItems;
  navCartBadge.hidden = totalCartItems === 0;

  // Carrito PC
  document.getElementById("pcCartItemsSummary").textContent = cartSummaryText;
  document.getElementById("pcCartItemsList").innerHTML = cartRowsHTML;
  document.getElementById("pcCartGrandTotal").textContent = formatPrice(totalCartMoney);
  document.getElementById("pcClearCartBtn").hidden = saleCart.length === 0;
  document.getElementById("pcConfirmCartSaleBtn").disabled = saleCart.length === 0;
  const pcNavCartBadge = document.getElementById("pcNavCartBadge");
  pcNavCartBadge.textContent = totalCartItems;
  pcNavCartBadge.hidden = totalCartItems === 0;

  document.getElementById("cameraGoToCartBtn").textContent =
    totalCartItems > 0
      ? `🛒 Ir a cobrar carrito (${totalCartItems} prod. · ${formatPrice(totalCartMoney)})`
      : "✕ Cerrar cámara";

  // Actualizar resultados de lupa en Vender (si hay algo escrito)
  renderPosSearchResults("pcPosSearchInput", "pcPosSearchResults", "pcPosClearSearchBtn");
  renderPosSearchResults("mobPosSearchInput", "mobPosSearchResults", "mobPosClearSearchBtn");

  // Últimas ventas cobradas
  document.getElementById("undoLastSaleBtn").hidden = salesHistory.length === 0;
  document.getElementById("pcUndoLastSaleBtn").hidden = salesHistory.length === 0;

  const salesHTML =
    salesHistory.length === 0
      ? `<div class="item-card" style="text-align:center; padding: 18px;"><p style="color:#475569; font-weight:700;">Aún no hay ventas registradas.</p></div>`
      : salesHistory
          .slice(0, 4)
          .map((s) => {
            const summary = Array.isArray(s.items)
              ? s.items.map((i) => `${i.qty}x ${i.name}`).join(", ")
              : s.summary || "Venta";
            return `
              <article class="item-card">
                <div class="item-top">
                  <div class="item-emoji" style="width:48px;height:48px;font-size:24px;">🧾</div>
                  <div class="item-info">
                    <h4 class="item-name" style="font-size:1.02rem;">${summary}</h4>
                    <div class="item-sub">
                      <span>Cobrado: <strong>${formatPrice(s.totalPrice)}</strong></span>
                      <span>· ${s.totalQty} prod.</span>
                      <span>· ${formatRelativeTime(s.timestamp)}</span>
                    </div>
                  </div>
                </div>
              </article>
            `;
          })
          .join("");

  document.getElementById("recentSalesList").innerHTML = salesHTML;
  document.getElementById("pcRecentSalesList").innerHTML = salesHTML;

  // --- Pantalla 2: Stock (Solo lectura) ---
  const readOnlyContainer = document.getElementById("readOnlyStockList");
  const pcReadOnlyTable = document.getElementById("pcReadOnlyTableBody");
  document.getElementById("pcTotalStockCounter").textContent = `${products.length} productos`;

  if (products.length === 0) {
    readOnlyContainer.innerHTML = `
      <div class="item-card" style="text-align:center; padding: 26px;">
        <p style="font-size:1.15rem; font-weight:800;">Tu stock está vacío</p>
        <p style="color:#475569; margin-top:6px;">Ve a <strong>✏️ Cargar</strong> para escanear tu primer producto paso a paso.</p>
      </div>
    `;
    pcReadOnlyTable.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center; padding:32px; color:#475569;">
          Tu stock está vacío. Haz clic en la pestaña <strong>✏️ Cargar</strong> para agregar tus productos paso a paso.
        </td>
      </tr>
    `;
  } else {
    readOnlyContainer.innerHTML = products
      .map((p) => {
        const st = getStockStatus(p);
        return `
          <article class="item-card ${st.cardClass}">
            <div class="item-top">
              ${renderProductThumbHTML(p)}
              <div class="item-info">
                <h4 class="item-name">${p.name}</h4>
                ${p.brand ? `<span class="item-brand-pill">Marca: ${p.brand}</span>` : ""}
                <div class="item-price-box">
                  <span class="item-price-label">VALOR:</span>
                  <strong class="item-price-value">${formatPrice(p.price)}</strong>
                </div>
                <div class="item-sub">
                  <span>${p.category}</span>
                  <span>· Vendidos mes: <strong>${p.soldMonth} u.</strong></span>
                </div>
              </div>
            </div>
            <div class="readonly-stock-footer">
              <span class="status-pill ${st.code}">${st.label}</span>
              <strong class="readonly-qty-badge">Quedan ${p.stock} u.</strong>
            </div>
          </article>
        `;
      })
      .join("");

    pcReadOnlyTable.innerHTML = products
      .map((p) => {
        const st = getStockStatus(p);
        return `
          <tr>
            <td>${renderProductThumbHTML(p, 52)}</td>
            <td><strong>${p.name}</strong></td>
            <td>${p.brand || "—"}</td>
            <td>${p.emoji} ${p.category}</td>
            <td><code>${p.barcode}</code></td>
            <td><span class="pc-table-price">${formatPrice(p.price)}</span></td>
            <td>${p.soldMonth} u.</td>
            <td><span class="pc-table-qty">${p.stock} unidades</span></td>
            <td><span class="status-pill ${st.code}">${st.label}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  // --- Pantalla 4: Resumen (Ventas del mes y recomendaciones) ---
  const totalMonthSold = products.reduce((acc, p) => acc + p.soldMonth, 0);
  document.getElementById("monthTotalUnitsSold").textContent = `${totalMonthSold} u.`;
  document.getElementById("pcMonthTotalUnitsSold").textContent = `${totalMonthSold} u.`;

  const sortedBySales = [...products].sort((a, b) => b.soldMonth - a.soldMonth);
  const maxSold = Math.max(1, sortedBySales[0]?.soldMonth || 1);

  const topSellersHTML =
    sortedBySales.length === 0
      ? `<p style="color:#475569; font-weight:700;">Aquí verás los productos más vendidos a medida que registres ventas.</p>`
      : sortedBySales
          .slice(0, 5)
          .map((p) => {
            const pct = Math.round((p.soldMonth / maxSold) * 100);
            return `
              <div class="top-seller-row">
                <div class="top-seller-head">
                  <span>${p.emoji} ${p.name}</span>
                  <strong>${p.soldMonth} vendidos</strong>
                </div>
                <div class="top-seller-bar-bg">
                  <div class="top-seller-bar-fill" style="width: ${pct}%"></div>
                </div>
              </div>
            `;
          })
          .join("");

  document.getElementById("topSellersList").innerHTML = topSellersHTML;
  document.getElementById("pcTopSellersList").innerHTML = topSellersHTML;

  const recommendations = products
    .map((p) => calculateSmartRestock(p))
    .filter((rec) => rec.recommendedToBuy > 0)
    .sort((a, b) => b.urgencyScore - a.urgencyScore);

  document.getElementById("monthSuggestedCount").textContent = `${recommendations.length} prod.`;
  document.getElementById("pcMonthSuggestedCount").textContent = `${recommendations.length} prod.`;

  const badge = document.getElementById("navLowStockBadge");
  badge.textContent = recommendations.length;
  badge.hidden = recommendations.length === 0;

  const pcLowBadge = document.getElementById("pcNavLowBadge");
  pcLowBadge.textContent = recommendations.length;
  pcLowBadge.hidden = recommendations.length === 0;

  let recHTML = "";
  if (products.length === 0) {
    recHTML = `
      <div class="item-card" style="text-align:center; padding: 26px; grid-column: 1 / -1;">
        <p style="font-size:1.15rem; font-weight:800;">Sin productos cargados todavía</p>
        <p style="color:#475569; margin-top:6px;">Cuando cargues tus productos y registres ventas, aquí verás el resumen del mes y cuánto te conviene comprar.</p>
      </div>
    `;
  } else if (recommendations.length === 0) {
    recHTML = `
      <div class="item-card" style="text-align:center; padding: 28px; grid-column: 1 / -1;">
        <p style="font-size:2rem;">🎉</p>
        <p style="font-size:1.2rem; font-weight:800;">¡Tu stock está al día según las ventas del mes!</p>
      </div>
    `;
  } else {
    recHTML = recommendations
      .map((rec) => {
        const p = rec.product;
        return `
          <article class="smart-rec-card ${rec.cardClass}">
            <span class="rec-priority-tag ${rec.priorityCode}">${rec.priorityLabel}</span>

            <div class="item-top">
              ${renderProductThumbHTML(p)}
              <div class="item-info">
                <h4 class="item-name">${p.name}</h4>
                <div class="item-sub">
                  <span>${p.perishable ? "⏳ Vence rápido (compra medida)" : "📦 Duradero (con margen extra)"}</span>
                </div>
              </div>
            </div>

            <div class="rec-stats-grid">
              <div class="rec-stat-col">
                <span>Ventas mes</span>
                <strong>${p.soldMonth} u.</strong>
              </div>
              <div class="rec-stat-col">
                <span>Quedan hoy</span>
                <strong>${p.stock} u.</strong>
              </div>
              <div class="rec-stat-col buy-highlight">
                <span>Comprar</span>
                <strong>+${rec.recommendedToBuy} u.</strong>
              </div>
            </div>

            <div class="rec-reason-box">
              💡 ${rec.explanation}
            </div>

            <button
              type="button"
              class="open-edit-item-btn accept-rec-btn"
              data-apply-rec="${p.barcode}"
              data-rec-amount="${rec.recommendedToBuy}"
            >
              ✅ Ya compré las +${rec.recommendedToBuy} unidades (Sumar al stock)
            </button>
          </article>
        `;
      })
      .join("");
  }

  document.getElementById("smartRecommendationsList").innerHTML = recHTML;
  document.getElementById("pcSmartRecommendationsList").innerHTML = recHTML;
}

function switchScreen(screenId) {
  activeNavScreen = screenId;

  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const mobTarget = document.getElementById(`screen-${screenId}`);
  if (mobTarget) mobTarget.classList.add("active");

  document.querySelectorAll(".bottom-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === screenId);
  });

  document.querySelectorAll(".pc-screen").forEach((s) => s.classList.remove("active"));
  const pcTarget = document.getElementById(`pc-screen-${screenId}`);
  if (pcTarget) pcTarget.classList.add("active");

  document.querySelectorAll(".pc-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === screenId);
  });

  if (screenId === "editar") {
    goToWizardStep(1);
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function compressImageFileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const size = 140;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =========================================================================
// MOTOR UNIVERSAL "ENCHUFAR Y USAR" PARA PISTOLAS LECTORAS DE CÓDIGO DE BARRAS
// Compatible con pistolas USB, Inalámbricas 2.4GHz (dongle USB) y Bluetooth
// (Honeywell, Zebra, Symbol, Datalogic, 3nStar, Netum, Tera y genéricas HID).
// Detecta ráfagas con o sin Enter/Tab final y actúa directo según el menú activo.
// =========================================================================
let gunBuffer = "";
let gunKeyTimestamps = [];
let gunLastKeyTime = 0;
let gunAutoFinalizeTimer = null;
let gunTargetInputSnapshot = null;

function cleanBarcodeGunString(raw) {
  // Algunas pistolas en teclado español/latino cambian '-' o envían caracteres de control;
  // conservamos dígitos y letras válidas de códigos EAN/UPC/Code128
  return String(raw || "")
    .replace(/[\r\n\t]/g, "")
    .trim();
}

async function dispatchHardwareGunBarcode(rawCode) {
  const code = cleanBarcodeGunString(rawCode);
  if (code.length < 4) return;

  // Si la cámara estaba abierta por casualidad, cerrarla
  if (!document.getElementById("cameraModal").hidden) {
    closeModal("cameraModal");
  }

  // Acción directa según el menú donde esté parada la persona (sin preguntar):
  if (activeNavScreen === "editar") {
    // Si está en el menú "Cargar": pasa directo al Paso 2 (Nombre) con el código ya leído
    playScannerBeep(false);
    await startWizardWithBarcode(code);
    showFeedback(`🔫 Código leído (${code}): revisa el nombre y pon el valor`);
  } else {
    // Si está en "Vender" (o en Stock/Resumen): pasa directo a armar la boleta (Cuenta del Cliente)
    if (activeNavScreen !== "escanear") {
      switchScreen("escanear");
    }
    await addProductToCart(code);
  }
}

function setupUniversalBarcodeGunListener() {
  window.addEventListener(
    "keydown",
    (e) => {
      // Ignorar teclas modificadoras sueltas
      if (
        e.key === "Shift" ||
        e.key === "Control" ||
        e.key === "Alt" ||
        e.key === "Meta" ||
        e.key === "CapsLock"
      ) {
        return;
      }

      const now = performance.now();
      const delta = now - gunLastKeyTime;

      // Si pasaron más de 95 ms desde la última tecla, reiniciar el buffer de ráfaga
      // (Una pistola lectora dispara cada dígito entre 2 ms y 45 ms; una persona tarda > 110 ms)
      const activeEl = document.activeElement;
      const isTypingInInput =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable);

      const maxGapMs = isTypingInInput ? 65 : 350;
      if (delta > maxGapMs) {
        gunBuffer = "";
        gunKeyTimestamps = [];
        gunTargetInputSnapshot = isTypingInInput
          ? { el: activeEl, valueBefore: activeEl.value }
          : null;
      }

      gunLastKeyTime = now;
      clearTimeout(gunAutoFinalizeTimer);

      // ¿Es tecla terminadora de pistola (Enter, NumpadEnter o Tab)?
      if (e.key === "Enter" || e.key === "NumpadEnter" || e.key === "Tab") {
        const avgGap =
          gunKeyTimestamps.length > 1
            ? (gunKeyTimestamps[gunKeyTimestamps.length - 1] - gunKeyTimestamps[0]) /
              (gunKeyTimestamps.length - 1)
            : 0;

        // Es una lectura de pistola si:
        // a) Tiene >= 5 caracteres escritos a velocidad de pistola (promedio < 65ms por tecla), O
        // b) No había ningún input enfocado y se recibieron >= 4 dígitos/caracteres seguidos de Enter
        const isRapidBurst = gunBuffer.length >= 5 && avgGap < 65;
        const isUnfocusedScan = !isTypingInInput && gunBuffer.length >= 4;

        if (isRapidBurst || isUnfocusedScan) {
          e.preventDefault();
          e.stopPropagation();

          // Si un input tenía el foco por accidente (ej: cuadro de precio o lupa),
          // restaurar su valor anterior para que el código de barras no se mezcle con el precio
          if (gunTargetInputSnapshot && gunTargetInputSnapshot.el) {
            const targetEl = gunTargetInputSnapshot.el;
            if (typeof targetEl.value === "string" && targetEl.value.endsWith(gunBuffer)) {
              targetEl.value = targetEl.value.slice(0, targetEl.value.length - gunBuffer.length);
            } else {
              targetEl.value = gunTargetInputSnapshot.valueBefore;
            }
          }

          const finalCode = gunBuffer;
          gunBuffer = "";
          gunKeyTimestamps = [];
          gunTargetInputSnapshot = null;
          dispatchHardwareGunBarcode(finalCode);
          return;
        }

        gunBuffer = "";
        gunKeyTimestamps = [];
        return;
      }

      // Acumular caracteres imprimibles (dígitos y letras de códigos EAN/UPC/Code128)
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (gunBuffer.length === 0 && isTypingInInput) {
          gunTargetInputSnapshot = { el: activeEl, valueBefore: activeEl.value };
        }

        gunBuffer += e.key;
        gunKeyTimestamps.push(now);

        // Soporte especial para pistolas configuradas SIN tecla Enter al final:
        // Si ya disparó >= 8 dígitos a velocidad de pistola (< 45 ms/tecla) y se detiene 130 ms,
        // lo procesa automáticamente sin necesidad de Enter.
        const avgGap =
          gunKeyTimestamps.length > 1
            ? (gunKeyTimestamps[gunKeyTimestamps.length - 1] - gunKeyTimestamps[0]) /
              (gunKeyTimestamps.length - 1)
            : 999;

        if (gunBuffer.length >= 8 && avgGap < 45 && /^[0-9A-Za-z\-]+$/.test(gunBuffer)) {
          gunAutoFinalizeTimer = setTimeout(() => {
            if (gunBuffer.length >= 8) {
              if (gunTargetInputSnapshot && gunTargetInputSnapshot.el) {
                const targetEl = gunTargetInputSnapshot.el;
                if (typeof targetEl.value === "string" && targetEl.value.endsWith(gunBuffer)) {
                  targetEl.value = targetEl.value.slice(0, targetEl.value.length - gunBuffer.length);
                } else {
                  targetEl.value = gunTargetInputSnapshot.valueBefore;
                }
              }
              const finalCode = gunBuffer;
              gunBuffer = "";
              gunKeyTimestamps = [];
              gunTargetInputSnapshot = null;
              dispatchHardwareGunBarcode(finalCode);
            }
          }, 130);
        }
      }
    },
    true
  );
}

// =========================================================================
// CÁMARA LECTORA DE CÓDIGOS DE BARRA Y QR
// =========================================================================
function onRealCodeDetected(rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) return;

  const now = Date.now();
  if (code === lastScannedCode && now - lastScannedTime < 1800) {
    return;
  }
  lastScannedCode = code;
  lastScannedTime = now;

  if (scannerMode === "sale") {
    addProductToCart(code);
  } else {
    playScannerBeep(false);
    closeModal("cameraModal");
    startWizardWithBarcode(code);
  }
}

async function openCameraScanner(mode) {
  scannerMode = mode;
  renderAll();

  const banner = document.getElementById("cameraModeBanner");
  const liveCamBox = document.getElementById("cameraLiveScanned");
  const torchBtn = document.getElementById("toggleTorchBtn");
  liveCamBox.hidden = true;
  torchBtn.hidden = true;
  torchOn = false;

  if (mode === "sale") {
    banner.textContent = "🛒 Modo Vender: Apunta al código para sumarlo a la cuenta";
    banner.classList.remove("edit-mode");
  } else {
    banner.textContent = "✏️ Paso 1: Apunta al código del producto para cargarlo";
    banner.classList.add("edit-mode");
  }

  document.getElementById("cameraModal").hidden = false;
  const video = document.getElementById("cameraVideo");
  const statusText = document.getElementById("cameraStatusText");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusText.textContent = "Cámara no disponible aquí. Escribe el número abajo.";
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = cameraStream;
    video.hidden = false;
    await video.play();
    statusText.textContent = "Apunta al código de barras o QR del producto";

    const track = cameraStream.getVideoTracks()[0];
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      if (caps && caps.torch) {
        torchBtn.hidden = false;
      }
    }

    scanLoopActive = true;
    startBarcodeDetectionLoop(video);
  } catch (_) {
    video.hidden = true;
    statusText.textContent = "Sin permiso de cámara: escribe el número de código abajo.";
  }
}

async function startBarcodeDetectionLoop(video) {
  if ("BarcodeDetector" in window) {
    try {
      const detector = new window.BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"],
      });

      const tick = async () => {
        if (!scanLoopActive || video.paused || video.ended) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length > 0 && codes[0].rawValue) {
            onRealCodeDetected(codes[0].rawValue);
          }
        } catch (_) {}
        if (scanLoopActive) {
          setTimeout(() => requestAnimationFrame(tick), 180);
        }
      };
      requestAnimationFrame(tick);
      return;
    } catch (_) {}
  }

  if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
    try {
      zxingReader = new window.ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromVideoElementContinuously(video, (result) => {
        if (result && scanLoopActive) {
          onRealCodeDetected(result.getText());
        }
      });
    } catch (_) {}
  }
}

async function toggleTorch() {
  if (!cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
  if (!track) return;
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    document.getElementById("toggleTorchBtn").textContent = torchOn ? "🔦 Apagar" : "🔦 Linterna";
  } catch (_) {}
}

function stopCameraStream() {
  scanLoopActive = false;
  if (zxingReader) {
    try {
      zxingReader.reset();
    } catch (_) {}
    zxingReader = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.hidden = true;
  if (modalId === "cameraModal") stopCameraStream();
}

function copySmartOrderToClipboard() {
  const products = window.minimarketDB.getAllProductsWithStats();
  const recs = products
    .map((p) => calculateSmartRestock(p))
    .filter((r) => r.recommendedToBuy > 0)
    .sort((a, b) => b.urgencyScore - a.urgencyScore);

  if (recs.length === 0) {
    showFeedback("🎉 No hace falta pedir mercadería hoy");
    return;
  }

  const lines = recs
    .map(
      (r) =>
        `• *${r.product.name}*: Comprar *${r.recommendedToBuy} u.* (Quedan ${r.product.stock}, se venden ${r.product.soldMonth}/mes)`
    )
    .join("\n");
  const text = `📊 *PEDIDO INTELIGENTE - MI MINIMARKET*\n${lines}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  showFeedback("📲 Pedido inteligente copiado para WhatsApp");
}

// =========================================================================
// INICIALIZACIÓN
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  detectDevicePosition();
  setupUniversalBarcodeGunListener();
  await window.minimarketDB.init();
  renderAll();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // Navegación principal (Vender, Stock, Cargar, Resumen)
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => switchScreen(btn.dataset.nav));
  });

  // Botones abrir cámara en Vender y en Paso 1 de Cargar
  document.getElementById("openSaleScannerBtn").addEventListener("click", () => openCameraScanner("sale"));
  document.getElementById("pcOpenSaleScannerBtn").addEventListener("click", () => openCameraScanner("sale"));
  document.getElementById("wizOpenScannerBtn").addEventListener("click", () => openCameraScanner("edit"));
  document.getElementById("toggleTorchBtn").addEventListener("click", toggleTorch);

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  // Lupa de búsqueda limpia en Vender (PC y Teléfono)
  const pcPosSearch = document.getElementById("pcPosSearchInput");
  const mobPosSearch = document.getElementById("mobPosSearchInput");
  pcPosSearch.addEventListener("input", () =>
    renderPosSearchResults("pcPosSearchInput", "pcPosSearchResults", "pcPosClearSearchBtn")
  );
  mobPosSearch.addEventListener("input", () =>
    renderPosSearchResults("mobPosSearchInput", "mobPosSearchResults", "mobPosClearSearchBtn")
  );

  document.getElementById("pcPosClearSearchBtn").addEventListener("click", () => {
    pcPosSearch.value = "";
    renderPosSearchResults("pcPosSearchInput", "pcPosSearchResults", "pcPosClearSearchBtn");
    pcPosSearch.focus();
  });
  document.getElementById("mobPosClearSearchBtn").addEventListener("click", () => {
    mobPosSearch.value = "";
    renderPosSearchResults("mobPosSearchInput", "mobPosSearchResults", "mobPosClearSearchBtn");
    mobPosSearch.focus();
  });

  // Código escrito a mano dentro de la cámara
  document.getElementById("manualBarcodeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("manualBarcodeInput");
    const code = input.value.trim();
    if (!code) return;
    input.value = "";
    if (scannerMode === "sale") {
      await addProductToCart(code);
    } else {
      closeModal("cameraModal");
      await startWizardWithBarcode(code);
    }
  });

  // =========================================================================
  // EVENTOS DEL ASISTENTE PASO A PASO EN "CARGAR"
  // =========================================================================
  const wizSearchInput = document.getElementById("wizSearchInput");
  wizSearchInput.addEventListener("input", renderWizardStep1Search);
  document.getElementById("wizClearSearchBtn").addEventListener("click", () => {
    wizSearchInput.value = "";
    renderWizardStep1Search();
    wizSearchInput.focus();
  });

  document.getElementById("wizManualNewBtn").addEventListener("click", () => {
    startWizardWithBarcode("");
  });

  document.getElementById("wizNameInput").addEventListener("input", (e) => {
    wizardState.name = e.target.value;
    document.getElementById("wizPreviewTitle").textContent = e.target.value || "Escribe el nombre";
  });

  // Bloquear negativos en stock y valor del asistente
  const wizStockInput = document.getElementById("wizStockInput");
  const wizPriceInput = document.getElementById("wizPriceInput");
  wizStockInput.addEventListener("input", () => sanitizeNonNegativeInput(wizStockInput));
  wizPriceInput.addEventListener("input", () => sanitizeNonNegativeInput(wizPriceInput));

  document.getElementById("wizStockMinusBtn").addEventListener("click", () => {
    wizStockInput.value = Math.max(0, (Number(wizStockInput.value) || 0) - 1);
  });
  document.getElementById("wizStockPlusBtn").addEventListener("click", () => {
    wizStockInput.value = Math.max(0, (Number(wizStockInput.value) || 0) + 1);
  });
  document.querySelectorAll("[data-wiz-pack]").forEach((btn) => {
    btn.addEventListener("click", () => {
      wizStockInput.value = Math.max(
        0,
        (Number(wizStockInput.value) || 0) + Number(btn.dataset.wizPack)
      );
    });
  });

  document.getElementById("wizPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFileToDataURL(file);
      wizardState.image = dataUrl;
      updateWizardStep2Preview();
      showFeedback("📸 Mini foto cargada");
    } catch (_) {}
  });

  document.getElementById("wizBackTo1Btn").addEventListener("click", () => goToWizardStep(1));

  document.getElementById("wizGoTo3Btn").addEventListener("click", () => {
    const nameVal = document.getElementById("wizNameInput").value.trim();
    if (!nameVal) {
      showFeedback("⚠️ Primero escribe el nombre del producto", true);
      document.getElementById("wizNameInput").focus();
      return;
    }
    goToWizardStep(3);
  });

  document.getElementById("wizBackTo2Btn").addEventListener("click", () => goToWizardStep(2));

  // Paso 3: Guardar finalmente el producto con su valor
  document.getElementById("wizSaveFinalBtn").addEventListener("click", async () => {
    const rawPrice = document.getElementById("wizPriceInput").value.trim();
    const priceVal = Math.max(0, Number(rawPrice) || 0);
    if (rawPrice === "" || priceVal <= 0) {
      showFeedback("⚠️ Escribe el valor de venta mayor a $0", true);
      document.getElementById("wizPriceInput").focus();
      return;
    }

    const finalName = document.getElementById("wizNameInput").value.trim() || "Producto";
    const finalStock = Math.max(0, Number(document.getElementById("wizStockInput").value) || 0);
    const finalImage =
      wizardState.image ||
      (window.ChileCatalog
        ? window.ChileCatalog.makeThumbSVG(
            "#1d4ed8",
            "#1e3a8a",
            wizardState.emoji || "📦",
            wizardState.brand || wizardState.category
          )
        : "");

    await window.minimarketDB.upsertProduct({
      barcode: wizardState.barcode,
      name: finalName,
      brand: wizardState.brand,
      image: finalImage,
      category: wizardState.category,
      emoji: wizardState.emoji,
      price: priceVal,
      stock: finalStock,
    });

    // Limpiar buscador del paso 1 y volver al paso 1 listo para el siguiente
    wizSearchInput.value = "";
    renderWizardStep1Search();
    renderAll();
    goToWizardStep(1);
    showFeedback(`✅ Guardado: ${finalName} → Valor ${formatPrice(priceVal)} (${finalStock} u.)`);
  });

  document.getElementById("wizDeleteExistingBtn").addEventListener("click", async () => {
    if (!wizardState.barcode) return;
    const ok = window.confirm(`¿Seguro que deseas eliminar "${wizardState.name}" del stock?`);
    if (!ok) return;
    await window.minimarketDB.deleteProduct(wizardState.barcode);
    renderAll();
    goToWizardStep(1);
    showFeedback(`🗑️ Eliminado: ${wizardState.name}`);
  });

  // =========================================================================
  // DELEGACIÓN GLOBAL DE CLICS (LUPA VENDER, CARRITO, WIZARD Y RESUMEN)
  // =========================================================================
  document.addEventListener("click", async (e) => {
    const quickSale = e.target.closest("[data-sale-barcode]");
    if (quickSale) {
      await addProductToCart(quickSale.dataset.saleBarcode);
      // Limpiar lupa después de elegir para que vuelva a quedar limpia
      pcPosSearch.value = "";
      mobPosSearch.value = "";
      renderPosSearchResults("pcPosSearchInput", "pcPosSearchResults", "pcPosClearSearchBtn");
      renderPosSearchResults("mobPosSearchInput", "mobPosSearchResults", "mobPosClearSearchBtn");
      return;
    }

    const wizPick = e.target.closest("[data-wiz-pick]");
    if (wizPick) {
      wizSearchInput.value = "";
      renderWizardStep1Search();
      await startWizardWithBarcode(wizPick.dataset.wizPick);
      return;
    }

    const cartStep = e.target.closest("[data-cart-code][data-cart-delta]");
    if (cartStep) {
      const res = await window.minimarketDB.updateCartQty(
        cartStep.dataset.cartCode,
        Number(cartStep.dataset.cartDelta)
      );
      if (res && res.error === "MAX_STOCK_REACHED") {
        playScannerBeep(true);
        showFeedback(
          `⚠️ No puedes agregar más: solo hay ${res.available} u. disponibles en stock.`,
          true
        );
      }
      renderAll();
      return;
    }

    const cartRemove = e.target.closest("[data-cart-remove]");
    if (cartRemove) {
      await window.minimarketDB.removeFromCart(cartRemove.dataset.cartRemove);
      renderAll();
      return;
    }

    const recBtn = e.target.closest("[data-apply-rec]");
    if (recBtn) {
      const amount = Math.max(0, Number(recBtn.dataset.recAmount) || 0);
      const updated = await window.minimarketDB.addStock(recBtn.dataset.applyRec, amount);
      if (updated) {
        renderAll();
        showFeedback(`✅ Guardado: Sumaste +${amount} u. a ${updated.name} (Quedan ${updated.stock})`);
      }
    }
  });

  // Vaciar carrito, Confirmar Venta y Anular última venta
  const handleClearCart = async () => {
    await window.minimarketDB.clearCart();
    document.getElementById("lastScannedBox").hidden = true;
    document.getElementById("pcLastScannedBox").hidden = true;
    renderAll();
    showFeedback("🗑️ Cuenta vaciada");
  };
  document.getElementById("clearCartBtn").addEventListener("click", handleClearCart);
  document.getElementById("pcClearCartBtn").addEventListener("click", handleClearCart);

  document.getElementById("confirmCartSaleBtn").addEventListener("click", confirmEntireCartSale);
  document.getElementById("pcConfirmCartSaleBtn").addEventListener("click", confirmEntireCartSale);

  document.getElementById("undoLastSaleBtn").addEventListener("click", handleUndoLastSale);
  document.getElementById("pcUndoLastSaleBtn").addEventListener("click", handleUndoLastSale);

  document.getElementById("shareListBtn").addEventListener("click", copySmartOrderToClipboard);
  document.getElementById("pcShareListBtn").addEventListener("click", copySmartOrderToClipboard);
});
