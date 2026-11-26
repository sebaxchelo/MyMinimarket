/* ==========================================================================
   Mi Minimarket — Base de Datos Local para el Teléfono (IndexedDB + LocalStorage)
   Inicia 100% limpia (sin productos de prueba) para cargar el negocio real.
   ========================================================================== */

const DB_NAME = "MiMinimarketDB_Real";
const DB_VERSION = 1;
const LS_BACKUP_KEY = "minimarket_real_db_v1";

const CATEGORY_EMOJI_MAP = {
  Abarrotes: "🍚",
  Bebidas: "🥤",
  Alcohol: "🍺",
  "Lácteos": "🥛",
  "Pan y Dulces": "🍪",
  Limpieza: "🧹",
};

class LocalMinimarketDB {
  constructor() {
    this.idb = null;
    this.state = {
      products: [],
      sales: [],
      cart: [],
    };
  }

  async init() {
    // Limpiar cualquier versión anterior con datos de demostración
    try {
      localStorage.removeItem("minimarket_local_db_v1");
    } catch (_) {}

    // 1. Cargar espejo rápido de LocalStorage si ya hay datos reales guardados
    const rawLS = localStorage.getItem(LS_BACKUP_KEY);
    if (rawLS) {
      try {
        const parsed = JSON.parse(rawLS);
        if (parsed && Array.isArray(parsed.products)) {
          this.state.products = parsed.products;
          this.state.sales = Array.isArray(parsed.sales) ? parsed.sales : [];
          this.state.cart = Array.isArray(parsed.cart) ? parsed.cart : [];
        }
      } catch (_) {}
    }

    // 2. Abrir IndexedDB
    try {
      this.idb = await this._openIndexedDB();
      const idbState = await this._readFromIndexedDB();
      if (idbState && Array.isArray(idbState.products)) {
        this.state = {
          products: idbState.products,
          sales: Array.isArray(idbState.sales) ? idbState.sales : [],
          cart: Array.isArray(idbState.cart) ? idbState.cart : [],
        };
      } else {
        await this.persist();
      }
    } catch (_) {
      this._saveToLocalStorage();
    }

    return this.state;
  }

  _openIndexedDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB no soportado"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv");
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  _readFromIndexedDB() {
    return new Promise((resolve, reject) => {
      if (!this.idb) return resolve(null);
      const tx = this.idb.transaction("kv", "readonly");
      const store = tx.objectStore("kv");
      const req = store.get("app_state");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  _writeToIndexedDB() {
    return new Promise((resolve) => {
      if (!this.idb) return resolve();
      try {
        const tx = this.idb.transaction("kv", "readwrite");
        const store = tx.objectStore("kv");
        store.put(this.state, "app_state");
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  _saveToLocalStorage() {
    try {
      localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(this.state));
    } catch (_) {}
  }

  async persist() {
    this._saveToLocalStorage();
    await this._writeToIndexedDB();
  }

  // Calcular ventas reales de los últimos 30 días
  getSoldInLast30Days(barcode) {
    const prod = this.state.products.find((p) => p.barcode === barcode);
    const base = prod ? Number(prod.baseSold30d || 0) : 0;
    const thirtyDaysAgo = Date.now() - 1000 * 60 * 60 * 24 * 30;

    let dynamicSold = 0;
    for (const sale of this.state.sales) {
      if (sale.timestamp >= thirtyDaysAgo && Array.isArray(sale.items)) {
        for (const item of sale.items) {
          if (item.barcode === barcode) {
            dynamicSold += Number(item.qty || 0);
          }
        }
      }
    }
    return base + dynamicSold;
  }

  getAllProductsWithStats() {
    return this.state.products.map((p) => ({
      ...p,
      soldMonth: this.getSoldInLast30Days(p.barcode),
    }));
  }

  findProduct(barcode) {
    const clean = String(barcode).trim();
    const p = this.state.products.find((item) => item.barcode === clean);
    if (!p) return null;
    return {
      ...p,
      soldMonth: this.getSoldInLast30Days(p.barcode),
    };
  }

  async upsertProduct({ barcode, name, brand, image, category, emoji, price, stock, minStock, perishable }) {
    const cleanCode = String(barcode).trim();
    const idx = this.state.products.findIndex((p) => p.barcode === cleanCode);
    const cat = category || "Abarrotes";
    const resolvedEmoji = emoji || CATEGORY_EMOJI_MAP[cat] || "📦";
    const isPerishable =
      typeof perishable === "boolean"
        ? perishable
        : cat === "Lácteos" || cat === "Pan y Dulces";

    if (idx >= 0) {
      this.state.products[idx] = {
        ...this.state.products[idx],
        name: name !== undefined ? name : this.state.products[idx].name,
        brand: brand !== undefined ? brand : this.state.products[idx].brand || "",
        image: image !== undefined ? image : this.state.products[idx].image || "",
        category: category !== undefined ? category : this.state.products[idx].category,
        emoji: emoji !== undefined ? emoji : this.state.products[idx].emoji,
        price: Math.max(0, Number(price)),
        stock: Math.max(0, Number(stock)),
        minStock: minStock !== undefined ? Number(minStock) : this.state.products[idx].minStock,
        perishable: isPerishable,
        updatedAt: Date.now(),
      };
    } else {
      this.state.products.unshift({
        barcode: cleanCode,
        name: name.trim(),
        brand: (brand || "").trim(),
        image: image || "",
        category: cat,
        emoji: resolvedEmoji,
        price: Math.max(0, Number(price) || 0),
        stock: Math.max(0, Number(stock) || 0),
        minStock: minStock !== undefined ? Number(minStock) : 5,
        baseSold30d: 0,
        perishable: isPerishable,
        updatedAt: Date.now(),
      });
    }

    await this.persist();
    return this.findProduct(cleanCode);
  }

  async deleteProduct(barcode) {
    const cleanCode = String(barcode).trim();
    this.state.products = this.state.products.filter((p) => p.barcode !== cleanCode);
    this.state.cart = this.state.cart.filter((c) => c.barcode !== cleanCode);
    await this.persist();
  }

  async addStock(barcode, amountToAdd) {
    const cleanCode = String(barcode).trim();
    const prod = this.state.products.find((p) => p.barcode === cleanCode);
    if (!prod) return null;
    prod.stock = Math.max(0, Number(prod.stock || 0) + Number(amountToAdd || 0));
    prod.updatedAt = Date.now();
    await this.persist();
    return this.findProduct(cleanCode);
  }

  // Operaciones del Carrito Persistente con limitador estricto de stock (nunca permite vender más de lo que hay)
  async addToCart(barcode, qty = 1) {
    const cleanCode = String(barcode).trim();
    const prod = this.state.products.find((p) => p.barcode === cleanCode);
    if (!prod) return { error: "NOT_FOUND", product: null };

    const availableStock = Math.max(0, Number(prod.stock || 0));
    if (availableStock <= 0) {
      return { error: "OUT_OF_STOCK", product: this.findProduct(cleanCode), available: 0 };
    }

    const existing = this.state.cart.find((i) => i.barcode === cleanCode);
    const currentInCart = existing ? Number(existing.qty || 0) : 0;

    if (currentInCart + qty > availableStock) {
      return {
        error: "MAX_STOCK_REACHED",
        product: this.findProduct(cleanCode),
        available: availableStock,
        inCart: currentInCart,
      };
    }

    if (existing) {
      existing.qty = currentInCart + qty;
    } else {
      this.state.cart.unshift({ barcode: cleanCode, qty });
    }
    await this.persist();
    return { error: null, product: this.findProduct(cleanCode), inCart: currentInCart + qty };
  }

  async updateCartQty(barcode, delta) {
    const cleanCode = String(barcode).trim();
    const item = this.state.cart.find((i) => i.barcode === cleanCode);
    if (!item) return { error: "NOT_IN_CART" };

    const prod = this.state.products.find((p) => p.barcode === cleanCode);
    const availableStock = prod ? Math.max(0, Number(prod.stock || 0)) : 0;

    if (delta > 0 && item.qty + delta > availableStock) {
      return {
        error: "MAX_STOCK_REACHED",
        product: this.findProduct(cleanCode),
        available: availableStock,
        inCart: item.qty,
      };
    }

    item.qty += delta;
    if (item.qty <= 0) {
      this.state.cart = this.state.cart.filter((i) => i.barcode !== cleanCode);
    }
    await this.persist();
    return { error: null };
  }

  async removeFromCart(barcode) {
    const cleanCode = String(barcode).trim();
    this.state.cart = this.state.cart.filter((i) => i.barcode !== cleanCode);
    await this.persist();
  }

  async clearCart() {
    this.state.cart = [];
    await this.persist();
  }

  async checkoutCart() {
    if (this.state.cart.length === 0) return null;

    const saleItems = [];
    let totalQty = 0;
    let totalPrice = 0;

    for (const cartItem of this.state.cart) {
      const prod = this.state.products.find((p) => p.barcode === cartItem.barcode);
      if (!prod) continue;

      prod.stock = Math.max(0, prod.stock - cartItem.qty);
      prod.updatedAt = Date.now();

      saleItems.push({
        barcode: prod.barcode,
        name: prod.name,
        emoji: prod.emoji,
        price: prod.price,
        qty: cartItem.qty,
      });

      totalQty += cartItem.qty;
      totalPrice += prod.price * cartItem.qty;
    }

    const newSale = {
      id: "sale-" + Date.now(),
      timestamp: Date.now(),
      items: saleItems,
      totalQty,
      totalPrice,
    };

    this.state.sales.unshift(newSale);
    this.state.cart = [];
    await this.persist();
    return newSale;
  }

  async undoLastSale() {
    if (this.state.sales.length === 0) return null;
    const lastSale = this.state.sales.shift();

    for (const item of lastSale.items) {
      const prod = this.state.products.find((p) => p.barcode === item.barcode);
      if (prod) {
        prod.stock += item.qty;
      }
    }

    await this.persist();
    return lastSale;
  }

  exportBackupJSON() {
    return JSON.stringify(this.state, null, 2);
  }

  async importBackupJSON(jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!parsed || !Array.isArray(parsed.products)) {
      throw new Error("Archivo de respaldo inválido");
    }
    this.state.products = parsed.products;
    this.state.sales = Array.isArray(parsed.sales) ? parsed.sales : [];
    this.state.cart = Array.isArray(parsed.cart) ? parsed.cart : [];
    await this.persist();
  }
}

window.minimarketDB = new LocalMinimarketDB();
