/* ==========================================================================
   Mi Minimarket — Aplicación 100% Funcional con Base de Datos Local
   y Lector Real de Códigos de Barra / QR por Cámara
   ========================================================================== */

let activeCategory = "todos";
let scannerMode = "sale"; // "sale" (agregar al carrito) o "edit" (modificar/crear producto)
let currentEditProduct = null;

// Variables de Cámara y Lector de Códigos Real
let cameraStream = null;
let scanLoopActive = false;
let zxingReader = null;
let torchOn = false;
let lastScannedCode = "";
let lastScannedTime = 0;

let bannerTimeout = null;
let selectedNewCat = "Abarrotes";
let selectedNewEmoji = "🍚";

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

// Sonido "bip" de supermercado + vibración suave en el teléfono
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
    explanation = `Se vendieron ${p.soldMonth} en el mes. Como puede vencer, te recomendamos comprar ${recommendedToBuy} u. (alcanza para ~${targetDays} días con un margen extra sin que se venza).`;
  } else if (p.soldMonth < 12) {
    explanation = `Sale lento (solo ${p.soldMonth} vendidos en el mes). Te recomendamos comprar apenas ${recommendedToBuy} u. para no acumular mercadería de más.`;
  } else {
    explanation = `Muy pedido (${p.soldMonth} vendidos este mes). Con ${recommendedToBuy} u. cubres 2 semanas de venta más un margen seguro para no quedarte corto.`;
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
// ACCIONES DEL CARRITO CONECTADAS A LA BASE DE DATOS LOCAL
// =========================================================================
async function addProductToCart(barcode) {
  const cleanCode = String(barcode).trim();
  const prod = window.minimarketDB.findProduct(cleanCode);

  playScannerBeep();

  if (!prod) {
    showFeedback("⚠️ Ese código no está registrado. Ve al menú 'Modificar' para crearlo.");
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
// RENDERIZADO GENERAL DESDE LA BASE DE DATOS LOCAL
// =========================================================================
function renderAll() {
  const products = window.minimarketDB.getAllProductsWithStats();
  const saleCart = window.minimarketDB.state.cart;
  const salesHistory = window.minimarketDB.state.sales;

  // Botones de acceso rápido en Caja (solo si ya hay productos guardados en el negocio)
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
        Escanea con la cámara o toca un producto arriba para ir armando la cuenta del cliente.
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
              <div>
                <div class="cart-item-name">${prod.emoji} ${prod.name}</div>
                <div class="cart-item-unit">Precio unitario: <strong>${formatPrice(prod.price)}</strong></div>
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

  // Historial de últimas ventas cobradas + botón Anular última
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

  // 2. Pantalla "Ver Stock" (Solo lectura seguro: SIEMPRE muestra todos los productos sin ningún filtro)
  const readOnlyContainer = document.getElementById("readOnlyStockList");
  if (products.length === 0) {
    readOnlyContainer.innerHTML = `
      <div class="item-card" style="text-align:center; padding: 26px;">
        <p style="font-size:1.15rem; font-weight:800;">Tu stock está vacío</p>
        <p style="color:#475569; margin-top:6px;">Toca abajo en <strong>✏️ Modificar</strong> para escanear y agregar tus productos reales.</p>
      </div>
    `;
  } else {
    readOnlyContainer.innerHTML = products
      .map((p) => {
        const st = getStockStatus(p);
        return `
          <article class="item-card ${st.cardClass}">
            <div class="item-top">
              <div class="item-emoji" aria-hidden="true">${p.emoji}</div>
              <div class="item-info">
                <h4 class="item-name">${p.name}</h4>
                <div class="item-price-box">
                  <span class="item-price-label">PRECIO:</span>
                  <strong class="item-price-value">${formatPrice(p.price)}</strong>
                </div>
                <div class="item-sub">
                  <span>Cód: ${p.barcode}</span>
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

  // 3. Pantalla "Modificar"
  const editQuery = (document.getElementById("editSearchInput").value || "").toLowerCase().trim();
  const filteredEdit = products.filter(
    (p) =>
      !editQuery ||
      p.name.toLowerCase().includes(editQuery) ||
      p.barcode.includes(editQuery) ||
      p.category.toLowerCase().includes(editQuery)
  );
  document.getElementById("editableProductsList").innerHTML =
    filteredEdit.length === 0
      ? `
        <div class="item-card" style="text-align:center; padding: 24px;">
          <p style="font-size:1.1rem; font-weight:800;">Aún no has cargado productos</p>
          <p style="color:#475569; margin-top:6px;">Usa los botones de arriba para escanear o agregar tu primer producto.</p>
        </div>
      `
      : filteredEdit
          .map((p) => {
            const st = getStockStatus(p);
            return `
              <article class="item-card ${st.cardClass}">
                <div class="item-top">
                  <div class="item-emoji" aria-hidden="true">${p.emoji}</div>
                  <div class="item-info">
                    <h4 class="item-name">${p.name}</h4>
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

  // 4. Pantalla "Qué Comprar" (Asistente inteligente)
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
              <div class="item-emoji">${p.emoji}</div>
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
// FLUJO EDITAR / CREAR PRODUCTO
// =========================================================================
function handleEditBarcodeScanned(barcode) {
  const cleanCode = String(barcode).trim();
  playScannerBeep();
  closeModal("cameraModal");

  const found = window.minimarketDB.findProduct(cleanCode);
  if (found) {
    openEditProductModal(found);
  } else {
    openNewProductModal(cleanCode);
    showFeedback(`🆕 Código ${cleanCode} nuevo: ponle nombre y precio para guardarlo`);
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

function openNewProductModal(prefillBarcode = "") {
  const codeInput = document.getElementById("newProdBarcode");
  codeInput.value = prefillBarcode || `780${Math.floor(1000000000 + Math.random() * 8999999999)}`;
  document.getElementById("newProdName").value = "";
  document.getElementById("newProdPrice").value = "";
  document.getElementById("newProdStock").value = "12";
  document.getElementById("newProductModal").hidden = false;
  setTimeout(() => document.getElementById("newProdName").focus(), 100);
}

// =========================================================================
// LECTOR REAL DE CÓDIGOS DE BARRA Y QR CON LA CÁMARA DEL TELÉFONO
// Soporta BarcodeDetector nativo (Android Chrome) + ZXing fallback (iOS/otros)
// =========================================================================
function onRealCodeDetected(rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) return;

  // Protección anti-doble-escaneo (1.8 segundos de espera para el mismo código)
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
    banner.textContent = "✏️ Modo Modificar: Apunta al código/QR para editar o crear";
    banner.classList.add("edit-mode");
  }

  document.getElementById("cameraModal").hidden = false;
  const video = document.getElementById("cameraVideo");
  const statusText = document.getElementById("cameraStatusText");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusText.textContent = "Cámara no disponible aquí. Usa los botones de abajo o escribe el código.";
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

    // Verificar si la cámara del teléfono tiene linterna (torch)
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
    statusText.textContent = "Sin permiso de cámara: toca un producto abajo o escribe el número.";
  }
}

async function startBarcodeDetectionLoop(video) {
  // 1. Usar BarcodeDetector nativo del teléfono si existe (Android Chrome, ultra rápido)
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

  // 2. Fallback con librería ZXing (para iPhones / Safari y otros navegadores)
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
  // 1. Iniciar la Base de Datos Local en el Teléfono
  await window.minimarketDB.init();
  renderAll();

  // 2. Registrar Service Worker para que funcione como App instalable (PWA) y sin internet
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // Navegación inferior
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => switchScreen(btn.dataset.nav));
  });

  // Cámara escáner
  document.getElementById("openSaleScannerBtn").addEventListener("click", () => openCameraScanner("sale"));
  document.getElementById("openEditScannerBtn").addEventListener("click", () => openCameraScanner("edit"));
  document.getElementById("toggleTorchBtn").addEventListener("click", toggleTorch);

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  // Ingreso manual de código en cámara
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

  // Delegación global de toques (Carrito, Botones rápidos, Editar, Recomendaciones)
  document.addEventListener("click", async (e) => {
    const quickSale = e.target.closest("[data-sale-barcode]");
    if (quickSale) {
      await addProductToCart(quickSale.dataset.saleBarcode);
      return;
    }

    const camSim = e.target.closest("[data-camera-sim]");
    if (camSim) {
      const code = camSim.dataset.cameraSim;
      if (scannerMode === "sale") {
        await addProductToCart(code);
      } else {
        handleEditBarcodeScanned(code);
      }
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

  // Vaciar carrito, Confirmar Venta y Anular última venta
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
    showFeedback(`💾 Guardado en el teléfono: ${newName} → ${formatPrice(newPrice)} (${newStock} u.)`);
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

  // Buscador en menú Modificar
  document.getElementById("editSearchInput").addEventListener("input", renderAll);

  // Crear Producto Nuevo
  document.getElementById("openNewProductBtn").addEventListener("click", () => openNewProductModal(""));

  document.getElementById("newProdCategoryPicker").addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-pick-btn");
    if (!btn) return;
    document.querySelectorAll("#newProdCategoryPicker .cat-pick-btn").forEach((b) =>
      b.classList.remove("active")
    );
    btn.classList.add("active");
    selectedNewCat = btn.dataset.cat;
    selectedNewEmoji = btn.dataset.emoji;
  });

  document.getElementById("newProductForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const barcode = document.getElementById("newProdBarcode").value.trim();
    const name = document.getElementById("newProdName").value.trim();
    const price = Math.max(0, Number(document.getElementById("newProdPrice").value) || 0);
    const stock = Math.max(0, Number(document.getElementById("newProdStock").value) || 0);

    if (!name) return;

    await window.minimarketDB.upsertProduct({
      barcode,
      name,
      category: selectedNewCat,
      emoji: selectedNewEmoji,
      price,
      stock,
    });

    renderAll();
    closeModal("newProductModal");
    showFeedback(`✅ Guardado en el teléfono: ${name} a ${formatPrice(price)}`);
  });

  // Gestión de copia de seguridad local (Exportar / Importar / Vaciar / Restaurar)
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

  // Copiar pedido inteligente para WhatsApp
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
