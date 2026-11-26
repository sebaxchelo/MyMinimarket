/* ==========================================================================
   Mi Minimarket — Aplicación Funcional con Reconocimiento Automático
   de Códigos de Barra de Chile (Nombre, Marca, Categoría y Mini Foto)
   ========================================================================== */

let scannerMode = "sale"; // "sale" (agregar al carrito) o "edit" (modificar/crear producto)
let currentEditProduct = null;

// Cámara y Lector Real
let cameraStream = null;
let scanLoopActive = false;
let zxingReader = null;
let torchOn = false;
let lastScannedCode = "";
let lastScannedTime = 0;

let bannerTimeout = null;
let selectedNewCat = "Abarrotes";
let selectedNewEmoji = "🍚";
let currentNewProdImage = "";

function formatPrice(num) {
  return "$" + Number(num || 0).toLocaleString("es-CL");
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

function playScannerBeep() {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(70);
    } catch (_) {}
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1180, ctx.currentTime);
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (_) {}
}

function showFeedback(text) {
  const banner = document.getElementById("feedbackBanner");
  banner.textContent = text;
  banner.hidden = false;
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.hidden = true;
  }, 3600);
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

// Renderizar Mini Foto del producto (o emoji si no tiene imagen)
function renderProductThumbHTML(p) {
  if (p.image) {
    return `<img src="${p.image}" alt="${p.name}" class="item-thumb-img" loading="lazy" onerror="this.style.display='none'" />`;
  }
  return `<div class="item-emoji" aria-hidden="true">${p.emoji || "📦"}</div>`;
}

// =========================================================================
// MOTOR DE RECOMENDACIÓN INTELIGENTE DE COMPRA (SEGÚN VENTAS DEL MES Y VENCIMIENTO)
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
// ACCIONES DEL CARRITO
// =========================================================================
async function addProductToCart(barcode) {
  const cleanCode = String(barcode).trim();
  const prod = window.minimarketDB.findProduct(cleanCode);

  playScannerBeep();

  if (!prod) {
    // Si escanea en Caja un producto que aún no tenía precio en su local, llevarla directo a ponerle precio
    closeModal("cameraModal");
    await openNewProductModalWithAutoLookup(cleanCode);
    showFeedback("🆕 Producto nuevo reconocido: solo ponle tu precio de venta");
    return;
  }

  await window.minimarketDB.addToCart(cleanCode, 1);

  const lastBox = document.getElementById("lastScannedBox");
  lastBox.hidden = false;
  document.getElementById("lastScannedName").textContent = `${prod.emoji} ${prod.name}`;
  document.getElementById("lastScannedPrice").textContent = formatPrice(prod.price);
  document.getElementById("lastScannedStock").textContent = `Stock actual: ${prod.stock} u.`;

  const liveCamBox = document.getElementById("cameraLiveScanned");
  if (!document.getElementById("cameraModal").hidden) {
    liveCamBox.hidden = false;
    liveCamBox.textContent = `✅ Sumado al carrito: ${prod.name} (${formatPrice(prod.price)})`;
  }

  renderAll();
  showFeedback(`🛒 Agregado: ${prod.name} → ${formatPrice(prod.price)}`);
}

async function confirmEntireCartSale() {
  const sale = await window.minimarketDB.checkoutCart();
  if (!sale) return;

  document.getElementById("lastScannedBox").hidden = true;
  renderAll();
  showFeedback(`✅ Venta guardada: Cobraste ${formatPrice(sale.totalPrice)} (${sale.totalQty} prod.)`);
}

async function handleUndoLastSale() {
  const undone = await window.minimarketDB.undoLastSale();
  if (!undone) return;
  renderAll();
  showFeedback(`↩️ Venta anulada (${formatPrice(undone.totalPrice)}). Se devolvió el stock.`);
}

// =========================================================================
// RENDERIZADO GENERAL
// =========================================================================
function renderAll() {
  const products = window.minimarketDB.getAllProductsWithStats();
  const saleCart = window.minimarketDB.state.cart;
  const salesHistory = window.minimarketDB.state.sales;

  // Botones de acceso rápido en Caja (solo si ya hay productos guardados)
  const top4 = [...products].sort((a, b) => b.soldMonth - a.soldMonth).slice(0, 4);
  const quickSaleBox = document.getElementById("quickSaleBox");
  const quickSaleContainer = document.getElementById("quickSaleButtons");
  if (top4.length === 0) {
    quickSaleBox.hidden = true;
    quickSaleContainer.innerHTML = "";
  } else {
    quickSaleBox.hidden = false;
    quickSaleContainer.innerHTML = top4
      .map(
        (p) => `
        <button type="button" class="demo-chip" data-sale-barcode="${p.barcode}">
          ${p.emoji} ${p.name.split(" ").slice(0, 2).join(" ")} (${formatPrice(p.price)})
        </button>
      `
      )
      .join("");
  }

  // 1. Renderizar Carrito
  const cartList = document.getElementById("cartItemsList");
  const cartFooter = document.getElementById("cartCheckoutFooter");
  const clearCartBtn = document.getElementById("clearCartBtn");
  const navCartBadge = document.getElementById("navCartBadge");
  const cameraGoToCartBtn = document.getElementById("cameraGoToCartBtn");

  let totalCartItems = 0;
  let totalCartMoney = 0;

  saleCart.forEach((item) => {
    const prod = products.find((p) => p.barcode === item.barcode);
    if (prod) {
      totalCartItems += item.qty;
      totalCartMoney += prod.price * item.qty;
    }
  });

  document.getElementById("cartItemsSummary").textContent =
    totalCartItems === 0
      ? "Todavía no hay productos en la cuenta"
      : `${totalCartItems} ${totalCartItems === 1 ? "unidad" : "unidades"} para cobrar`;

  navCartBadge.textContent = totalCartItems;
  navCartBadge.hidden = totalCartItems === 0;
  clearCartBtn.hidden = saleCart.length === 0;
  cartFooter.hidden = saleCart.length === 0;
  cameraGoToCartBtn.textContent =
    totalCartItems > 0
      ? `🛒 Ir a cobrar carrito (${totalCartItems} prod. · ${formatPrice(totalCartMoney)})`
      : "✕ Cerrar cámara";

  if (saleCart.length === 0) {
    cartList.innerHTML = `
      <div class="cart-empty-box">
        Escanea con la cámara para ir armando la cuenta del cliente.
      </div>
    `;
  } else {
    cartList.innerHTML = saleCart
      .map((item) => {
        const prod = products.find((p) => p.barcode === item.barcode);
        if (!prod) return "";
        const subtotal = prod.price * item.qty;
        return `
          <div class="cart-item-row">
            <div class="cart-item-top">
              <div style="display:flex; gap:10px; align-items:center;">
                ${renderProductThumbHTML(prod)}
                <div>
                  <div class="cart-item-name">${prod.name}</div>
                  <div class="cart-item-unit">Precio unitario: <strong>${formatPrice(prod.price)}</strong></div>
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
                <button type="button" class="cart-step-btn plus" data-cart-delta="1" data-cart-code="${prod.barcode}">+</button>
              </div>
              <strong class="cart-item-subtotal">${formatPrice(subtotal)}</strong>
            </div>
          </div>
        `;
      })
      .join("");
  }

  document.getElementById("cartGrandTotal").textContent = formatPrice(totalCartMoney);

  // Historial de últimas ventas
  const undoBtn = document.getElementById("undoLastSaleBtn");
  undoBtn.hidden = salesHistory.length === 0;

  const recentSalesContainer = document.getElementById("recentSalesList");
  if (salesHistory.length === 0) {
    recentSalesContainer.innerHTML = `
      <div class="item-card" style="text-align:center; padding: 20px;">
        <p style="color:#475569; font-weight:700;">Aún no hay ventas registradas.</p>
      </div>
    `;
  } else {
    recentSalesContainer.innerHTML = salesHistory
      .slice(0, 4)
      .map((s) => {
        const summary = Array.isArray(s.items)
          ? s.items.map((i) => `${i.qty}x ${i.name}`).join(", ")
          : s.summary || "Venta";
        return `
          <article class="item-card">
            <div class="item-top">
              <div class="item-emoji">🧾</div>
              <div class="item-info">
                <h4 class="item-name">${summary}</h4>
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
  }

  // 2. Pantalla "Ver Stock" (SIEMPRE muestra todos los productos con su mini foto y precio)
  const readOnlyContainer = document.getElementById("readOnlyStockList");
  if (products.length === 0) {
    readOnlyContainer.innerHTML = `
      <div class="item-card" style="text-align:center; padding: 26px;">
        <p style="font-size:1.15rem; font-weight:800;">Tu stock está vacío</p>
        <p style="color:#475569; margin-top:6px;">Toca abajo en <strong>✏️ Modificar</strong> para escanear o elegir tus productos y ponerles tu precio.</p>
      </div>
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
                  <span class="item-price-label">PRECIO:</span>
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
  }

  // 3. Pantalla "Modificar" (Catálogo de Chile + productos ya cargados)
  renderChileCatalogSuggestions();

  const editQuery = (document.getElementById("editSearchInput").value || "").toLowerCase().trim();
  const filteredEdit = products.filter(
    (p) =>
      !editQuery ||
      p.name.toLowerCase().includes(editQuery) ||
      (p.brand && p.brand.toLowerCase().includes(editQuery)) ||
      p.barcode.includes(editQuery) ||
      p.category.toLowerCase().includes(editQuery)
  );

  document.getElementById("editableProductsList").innerHTML =
    filteredEdit.length === 0
      ? `
        <div class="item-card" style="text-align:center; padding: 24px;">
          <p style="font-size:1.1rem; font-weight:800;">Aún no has cargado productos en tu local</p>
          <p style="color:#475569; margin-top:6px;">Escanea un código arriba o toca cualquier producto de la Base de Datos de Chile para agregarlo solo poniendo tu precio.</p>
        </div>
      `
      : filteredEdit
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
                      <span class="item-price-label">PRECIO:</span>
                      <strong class="item-price-value">${formatPrice(p.price)}</strong>
                    </div>
                    <div class="item-sub">
                      <span>Stock actual: <strong>${p.stock} unidades</strong></span>
                      <span>· Cód: ${p.barcode}</span>
                    </div>
                  </div>
                </div>
                <button type="button" class="open-edit-item-btn" data-open-edit="${p.barcode}">
                  ✏️ Tocar para cambiar stock o precio
                </button>
              </article>
            `;
          })
          .join("");

  // 4. Pantalla "Qué Comprar"
  const totalMonthSold = products.reduce((acc, p) => acc + p.soldMonth, 0);
  document.getElementById("monthTotalUnitsSold").textContent = `${totalMonthSold} u.`;

  const sortedBySales = [...products].sort((a, b) => b.soldMonth - a.soldMonth);
  const maxSold = Math.max(1, sortedBySales[0]?.soldMonth || 1);

  document.getElementById("topSellersList").innerHTML =
    sortedBySales.length === 0
      ? `<p style="color:#475569; font-weight:700;">Aquí verás los productos más vendidos a medida que registres ventas.</p>`
      : sortedBySales
          .slice(0, 4)
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

  const recommendations = products
    .map((p) => calculateSmartRestock(p))
    .filter((rec) => rec.recommendedToBuy > 0)
    .sort((a, b) => b.urgencyScore - a.urgencyScore);

  document.getElementById("monthSuggestedCount").textContent = `${recommendations.length} prod.`;
  const badge = document.getElementById("navLowStockBadge");
  badge.textContent = recommendations.length;
  badge.hidden = recommendations.length === 0;

  const recContainer = document.getElementById("smartRecommendationsList");
  if (products.length === 0) {
    recContainer.innerHTML = `
      <div class="item-card" style="text-align:center; padding: 26px;">
        <p style="font-size:1.15rem; font-weight:800;">Sin productos cargados todavía</p>
        <p style="color:#475569; margin-top:6px;">Cuando cargues tus productos y registres ventas, el sistema calculará aquí cuánto te conviene comprar sin pasarte de stock.</p>
      </div>
    `;
  } else if (recommendations.length === 0) {
    recContainer.innerHTML = `
      <div class="item-card" style="text-align:center; padding: 28px;">
        <p style="font-size:2rem;">🎉</p>
        <p style="font-size:1.2rem; font-weight:800;">¡Tu stock está al día según las ventas del mes!</p>
      </div>
    `;
  } else {
    recContainer.innerHTML = recommendations
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
}

// Mostrar sugerencias con mini foto del Catálogo de Minimarket Chile
function renderChileCatalogSuggestions() {
  const input = document.getElementById("chileCatalogSearchInput");
  const container = document.getElementById("chileCatalogSuggestions");
  if (!input || !container || !window.ChileCatalog) return;

  const list = window.ChileCatalog.searchSuggestions(input.value);
  container.innerHTML = list
    .map(
      (item) => `
      <button type="button" class="demo-chip" data-pick-chile-barcode="${item.barcode}">
        <img src="${item.image}" alt="" class="catalog-chip-thumb" />
        <span style="overflow:hidden; text-overflow:ellipsis;">${item.name}</span>
      </button>
    `
    )
    .join("");
}

function switchScreen(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(`screen-${screenId}`);
  if (target) target.classList.add("active");

  document.querySelectorAll(".bottom-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === screenId);
  });

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// =========================================================================
// RECONOCIMIENTO AUTOMÁTICO DE PRODUCTO (NOMBRE, MARCA, CATEGORÍA Y MINI FOTO)
// =========================================================================
function setCategoryPickerUI(cat, emoji) {
  selectedNewCat = cat || "Abarrotes";
  selectedNewEmoji = emoji || "🍚";
  document.querySelectorAll("#newProdCategoryPicker .cat-pick-btn").forEach((b) => {
    const isMatch = b.dataset.cat === selectedNewCat;
    b.classList.toggle("active", isMatch);
    if (isMatch) selectedNewEmoji = b.dataset.emoji;
  });
}

function updateRecognizedPreviewCard({ found, name, brand, image, emoji, statusText }) {
  const card = document.getElementById("recognizedProductCard");
  const pill = document.getElementById("recognizedStatusPill");
  const imgEl = document.getElementById("newProdPreviewImg");
  const emojiEl = document.getElementById("newProdPreviewEmoji");
  const nameEl = document.getElementById("recognizedNamePreview");
  const brandEl = document.getElementById("recognizedBrandPreview");

  card.classList.toggle("not-found", !found);
  pill.textContent =
    statusText ||
    (found
      ? "✨ Reconocido automáticamente (Solo pon tu precio)"
      : "✍️ Código nuevo: escribe el nombre y tu precio");

  nameEl.textContent = name || "Producto sin nombre aún";
  brandEl.textContent = brand ? `Marca: ${brand}` : "Marca: Minimarket";

  currentNewProdImage = image || "";
  if (currentNewProdImage) {
    imgEl.src = currentNewProdImage;
    imgEl.hidden = false;
    emojiEl.hidden = true;
  } else {
    imgEl.hidden = true;
    emojiEl.textContent = emoji || "📦";
    emojiEl.hidden = false;
  }
}

async function openNewProductModalWithAutoLookup(prefillBarcode = "") {
  const cleanCode =
    String(prefillBarcode || "").trim() ||
    `780${Math.floor(1000000000 + Math.random() * 8999999999)}`;

  document.getElementById("newProdBarcode").value = cleanCode;
  document.getElementById("newProdPrice").value = "";
  document.getElementById("newProdStock").value = "12";
  document.getElementById("newProductModal").hidden = false;

  // Si tenía código, buscarlo automáticamente en el Catálogo de Chile + OpenFoodFacts/OpenProductsFacts
  if (prefillBarcode && window.ChileCatalog) {
    updateRecognizedPreviewCard({
      found: true,
      name: "Buscando código en base de datos de Chile...",
      brand: "Consultando...",
      image: "",
      emoji: "🔍",
      statusText: "🔍 Buscando nombre, marca y foto...",
    });

    const result = await window.ChileCatalog.lookupByBarcode(cleanCode);
    if (result && result.found) {
      document.getElementById("newProdName").value = result.name;
      document.getElementById("newProdBrand").value = result.brand || "";
      setCategoryPickerUI(result.category, result.emoji);
      updateRecognizedPreviewCard({
        found: true,
        name: result.name,
        brand: result.brand,
        image: result.image,
        emoji: result.emoji,
      });
      // Enfocar directo en el PRECIO para que ella solo ponga su valor de venta
      setTimeout(() => document.getElementById("newProdPrice").focus(), 120);
      return;
    }
  }

  // Si no se encontró en la base de datos, dejar listo para escribir nombre y precio
  document.getElementById("newProdName").value = "";
  document.getElementById("newProdBrand").value = "";
  setCategoryPickerUI("Abarrotes", "🍚");
  updateRecognizedPreviewCard({
    found: false,
    name: "Escribe el nombre abajo",
    brand: "",
    image: "",
    emoji: "📦",
  });
  setTimeout(() => document.getElementById("newProdName").focus(), 120);
}

async function handleEditBarcodeScanned(barcode) {
  const cleanCode = String(barcode).trim();
  playScannerBeep();
  closeModal("cameraModal");

  const foundInStore = window.minimarketDB.findProduct(cleanCode);
  if (foundInStore) {
    openEditProductModal(foundInStore);
  } else {
    await openNewProductModalWithAutoLookup(cleanCode);
  }
}

function openEditProductModal(prod) {
  currentEditProduct = prod;
  document.getElementById("editModalEmoji").textContent = prod.emoji;
  document.getElementById("editModalProductName").textContent = prod.name;
  document.getElementById("editModalBarcode").textContent = `║▌║█ ${prod.barcode}`;
  document.getElementById("editModalNameInput").value = prod.name;
  document.getElementById("editModalPriceInput").value = prod.price;
  document.getElementById("editModalStockInput").value = prod.stock;
  document.getElementById("editProductModal").hidden = false;
}

// Redimensionar foto tomada con la cámara del celular a una mini foto ligera (140x140 JPEG)
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
// LECTOR REAL DE CÓDIGOS DE BARRA Y QR CON LA CÁMARA
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
    handleEditBarcodeScanned(code);
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
    banner.textContent = "🛒 Modo Caja: Apunta al código para sumarlo al carrito";
    banner.classList.remove("edit-mode");
  } else {
    banner.textContent = "✏️ Modo Modificar: Apunta al código para reconocer el producto";
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

// =========================================================================
// INICIALIZACIÓN
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  await window.minimarketDB.init();
  renderAll();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => switchScreen(btn.dataset.nav));
  });

  document.getElementById("openSaleScannerBtn").addEventListener("click", () => openCameraScanner("sale"));
  document.getElementById("openEditScannerBtn").addEventListener("click", () => openCameraScanner("edit"));
  document.getElementById("toggleTorchBtn").addEventListener("click", toggleTorch);

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  document.getElementById("manualBarcodeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("manualBarcodeInput");
    const code = input.value.trim();
    if (!code) return;
    input.value = "";
    if (scannerMode === "sale") {
      addProductToCart(code);
    } else {
      handleEditBarcodeScanned(code);
    }
  });

  // Delegación global
  document.addEventListener("click", async (e) => {
    const quickSale = e.target.closest("[data-sale-barcode]");
    if (quickSale) {
      await addProductToCart(quickSale.dataset.saleBarcode);
      return;
    }

    const pickChile = e.target.closest("[data-pick-chile-barcode]");
    if (pickChile) {
      const code = pickChile.dataset.pickChileBarcode;
      await handleEditBarcodeScanned(code);
      return;
    }

    const cartStep = e.target.closest("[data-cart-code][data-cart-delta]");
    if (cartStep) {
      await window.minimarketDB.updateCartQty(
        cartStep.dataset.cartCode,
        Number(cartStep.dataset.cartDelta)
      );
      renderAll();
      return;
    }

    const cartRemove = e.target.closest("[data-cart-remove]");
    if (cartRemove) {
      await window.minimarketDB.removeFromCart(cartRemove.dataset.cartRemove);
      renderAll();
      return;
    }

    const editBtn = e.target.closest("[data-open-edit]");
    if (editBtn) {
      const prod = window.minimarketDB.findProduct(editBtn.dataset.openEdit);
      if (prod) openEditProductModal(prod);
      return;
    }

    const recBtn = e.target.closest("[data-apply-rec]");
    if (recBtn) {
      const amount = Number(recBtn.dataset.recAmount) || 0;
      const updated = await window.minimarketDB.addStock(recBtn.dataset.applyRec, amount);
      if (updated) {
        renderAll();
        showFeedback(`✅ Guardado: Sumaste +${amount} u. a ${updated.name} (Quedan ${updated.stock})`);
      }
    }
  });

  // Carrito y ventas
  document.getElementById("clearCartBtn").addEventListener("click", async () => {
    await window.minimarketDB.clearCart();
    document.getElementById("lastScannedBox").hidden = true;
    renderAll();
    showFeedback("🗑️ Cuenta vaciada");
  });

  document.getElementById("confirmCartSaleBtn").addEventListener("click", confirmEntireCartSale);
  document.getElementById("undoLastSaleBtn").addEventListener("click", handleUndoLastSale);

  // Modal Modificar Producto
  document.getElementById("editStockMinusBtn").addEventListener("click", () => {
    const inp = document.getElementById("editModalStockInput");
    inp.value = Math.max(0, (Number(inp.value) || 0) - 1);
  });
  document.getElementById("editStockPlusBtn").addEventListener("click", () => {
    const inp = document.getElementById("editModalStockInput");
    inp.value = Math.max(0, (Number(inp.value) || 0) + 1);
  });
  document.querySelectorAll("[data-edit-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById("editModalStockInput");
      inp.value = Math.max(0, (Number(inp.value) || 0) + Number(btn.dataset.editAdd));
    });
  });

  document.getElementById("saveEditedProductBtn").addEventListener("click", async () => {
    if (!currentEditProduct) return;
    const newName = document.getElementById("editModalNameInput").value.trim() || currentEditProduct.name;
    const newPrice = Math.max(0, Number(document.getElementById("editModalPriceInput").value) || 0);
    const newStock = Math.max(0, Number(document.getElementById("editModalStockInput").value) || 0);

    await window.minimarketDB.upsertProduct({
      barcode: currentEditProduct.barcode,
      name: newName,
      price: newPrice,
      stock: newStock,
    });

    renderAll();
    closeModal("editProductModal");
    showFeedback(`💾 Guardado: ${newName} → ${formatPrice(newPrice)} (${newStock} u.)`);
  });

  document.getElementById("deleteProductBtn").addEventListener("click", async () => {
    if (!currentEditProduct) return;
    const ok = window.confirm(`¿Seguro que deseas eliminar "${currentEditProduct.name}" del catálogo?`);
    if (!ok) return;
    await window.minimarketDB.deleteProduct(currentEditProduct.barcode);
    renderAll();
    closeModal("editProductModal");
    showFeedback(`🗑️ Producto eliminado: ${currentEditProduct.name}`);
  });

  // Buscadores en menú Modificar
  document.getElementById("editSearchInput").addEventListener("input", renderAll);
  document.getElementById("chileCatalogSearchInput").addEventListener("input", renderChileCatalogSuggestions);

  // Modal Agregar Producto Nuevo
  document.getElementById("openNewProductBtn").addEventListener("click", () =>
    openNewProductModalWithAutoLookup("")
  );

  document.getElementById("newStockMinusBtn").addEventListener("click", () => {
    const inp = document.getElementById("newProdStock");
    inp.value = Math.max(0, (Number(inp.value) || 0) - 1);
  });
  document.getElementById("newStockPlusBtn").addEventListener("click", () => {
    const inp = document.getElementById("newProdStock");
    inp.value = Math.max(0, (Number(inp.value) || 0) + 1);
  });

  // Si escribe o cambia el código manualmente dentro del modal Nuevo Producto, buscarlo en la base de datos de Chile
  document.getElementById("lookupCodeManualBtn").addEventListener("click", async () => {
    const code = document.getElementById("newProdBarcode").value.trim();
    if (code) await openNewProductModalWithAutoLookup(code);
  });

  // Actualizar vista previa si edita el nombre o marca a mano
  document.getElementById("newProdName").addEventListener("input", (e) => {
    document.getElementById("recognizedNamePreview").textContent = e.target.value || "Producto Nuevo";
  });
  document.getElementById("newProdBrand").addEventListener("input", (e) => {
    document.getElementById("recognizedBrandPreview").textContent = e.target.value
      ? `Marca: ${e.target.value}`
      : "Marca: Minimarket";
  });

  // Tomar o elegir mini foto del envase con la cámara del teléfono
  document.getElementById("newProdPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFileToDataURL(file);
      currentNewProdImage = dataUrl;
      const imgEl = document.getElementById("newProdPreviewImg");
      imgEl.src = dataUrl;
      imgEl.hidden = false;
      document.getElementById("newProdPreviewEmoji").hidden = true;
      showFeedback("📸 Mini foto cargada");
    } catch (_) {}
  });

  document.getElementById("newProdCategoryPicker").addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-pick-btn");
    if (!btn) return;
    setCategoryPickerUI(btn.dataset.cat, btn.dataset.emoji);
  });

  document.getElementById("newProductForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const barcode = document.getElementById("newProdBarcode").value.trim();
    const name = document.getElementById("newProdName").value.trim();
    const brand = document.getElementById("newProdBrand").value.trim();
    const price = Math.max(0, Number(document.getElementById("newProdPrice").value) || 0);
    const stock = Math.max(0, Number(document.getElementById("newProdStock").value) || 0);

    if (!name) return;

    const finalImage =
      currentNewProdImage ||
      (window.ChileCatalog
        ? window.ChileCatalog.makeThumbSVG("#1d4ed8", "#1e3a8a", selectedNewEmoji, brand || selectedNewCat)
        : "");

    await window.minimarketDB.upsertProduct({
      barcode,
      name,
      brand,
      image: finalImage,
      category: selectedNewCat,
      emoji: selectedNewEmoji,
      price,
      stock,
    });

    renderAll();
    closeModal("newProductModal");
    showFeedback(`✅ Guardado: ${name} a ${formatPrice(price)}`);
  });

  // Copia de seguridad
  document.getElementById("exportBackupBtn").addEventListener("click", () => {
    const json = window.minimarketDB.exportBackupJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `respaldo-minimarket-${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showFeedback("📥 Copia de seguridad descargada en el teléfono");
  });

  document.getElementById("importBackupInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await window.minimarketDB.importBackupJSON(text);
      renderAll();
      showFeedback("✅ Copia de seguridad restaurada con éxito");
    } catch (_) {
      showFeedback("⚠️ No se pudo leer el archivo de respaldo");
    }
    e.target.value = "";
  });

  document.getElementById("shareListBtn").addEventListener("click", () => {
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
  });
});
