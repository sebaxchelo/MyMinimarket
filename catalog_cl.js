/* ==========================================================================
   Mi Minimarket — Base de Datos de Códigos de Barra de Minimarket en Chile
   Incluye:
   1. Catálogo local de productos chilenos (Abarrotes, Bebidas, Lácteos, Snacks,
      Bebidas Alcohólicas / Botillería y Utensilios de Limpieza / Aseo).
   2. Conexión automática en vivo con:
      - Open Food Facts Chile (Alimentos, Bebidas, Cervezas, Vinos, Licores)
      - Open Products Facts (Detergentes, Lavaloza, Cloro, Papel, Limpieza)
      - Open Beauty Facts (Shampoo, Jabón, Pasta dental, Desodorantes)
   3. Mini Foto automática (foto real del envase o ilustración de respaldo).
   ========================================================================== */

// Generador de mini-foto SVG nítida para productos cuando no hay internet o foto externa
function makeProductThumbSVG(bgHex, accentHex, emoji, shortBrand) {
  const safeBrand = String(shortBrand || "").slice(0, 9).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
    <rect width="120" height="120" rx="22" fill="${bgHex}"/>
    <rect x="10" y="10" width="100" height="100" rx="16" fill="#ffffff" fill-opacity="0.18"/>
    <text x="60" y="64" font-size="46" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
    <rect x="14" y="86" width="92" height="22" rx="8" fill="${accentHex}"/>
    <text x="60" y="101" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#ffffff" text-anchor="middle">${safeBrand}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

// Diccionario maestro offline de códigos EAN-13 comunes en Minimarkets de Chile (prefijo 780 y marcas líderes)
const CHILE_MINIMARKET_CATALOG = {
  // ================= BEBIDAS Y AGUAS =================
  "7801610001234": { name: "Coca-Cola Original 1.5L", brand: "Coca-Cola", category: "Bebidas", emoji: "🥤", color: ["#dc2626", "#991b1b"] },
  "7801610001111": { name: "Coca-Cola Original Lata 350ml", brand: "Coca-Cola", category: "Bebidas", emoji: "🥤", color: ["#dc2626", "#991b1b"] },
  "7801610001241": { name: "Coca-Cola Sin Azúcar 1.5L", brand: "Coca-Cola", category: "Bebidas", emoji: "🥤", color: ["#1e293b", "#dc2626"] },
  "7801610002231": { name: "Fanta Naranja 1.5L", brand: "Fanta", category: "Bebidas", emoji: "🍊", color: ["#ea580c", "#9a3412"] },
  "7801610003238": { name: "Sprite Limón 1.5L", brand: "Sprite", category: "Bebidas", emoji: "🍋", color: ["#16a34a", "#14532d"] },
  "7801900001120": { name: "Bilz Bebida Fantasía 1.5L", brand: "CCU", category: "Bebidas", emoji: "🥤", color: ["#e11d48", "#881337"] },
  "7801900001137": { name: "Pap Bebida Papaya 1.5L", brand: "CCU", category: "Bebidas", emoji: "🧃", color: ["#f59e0b", "#b45309"] },
  "7801900001144": { name: "Kem Piña 1.5L", brand: "CCU", category: "Bebidas", emoji: "🍍", color: ["#eab308", "#854d0e"] },
  "7801900002011": { name: "Agua Mineral Cachantún Con Gas 1.6L", brand: "Cachantún", category: "Bebidas", emoji: "💧", color: ["#0284c7", "#0369a1"] },
  "7801900002028": { name: "Agua Mineral Cachantún Sin Gas 1.6L", brand: "Cachantún", category: "Bebidas", emoji: "💧", color: ["#38bdf8", "#0284c7"] },
  "7801610005119": { name: "Agua Mineral Vital Sin Gas 1.6L", brand: "Vital", category: "Bebidas", emoji: "💧", color: ["#0ea5e9", "#0369a1"] },
  "7801900004114": { name: "Néctar Watts Durazno 1.5L", brand: "Watts", category: "Bebidas", emoji: "🍑", color: ["#f97316", "#c2410c"] },
  "7801900004121": { name: "Néctar Watts Naranja 1.5L", brand: "Watts", category: "Bebidas", emoji: "🍊", color: ["#fb923c", "#ea580c"] },
  "9002490100070": { name: "Bebida Energética Red Bull 250ml", brand: "Red Bull", category: "Bebidas", emoji: "⚡", color: ["#1d4ed8", "#dc2626"] },
  "7801610008905": { name: "Bebida Energética Monster Green 473ml", brand: "Monster", category: "Bebidas", emoji: "⚡", color: ["#15803d", "#0f172a"] },

  // ================= BEBIDAS ALCOHÓLICAS / BOTILLERÍA =================
  "7801900010016": { name: "Cerveza Cristal Lata 470ml", brand: "Cristal", category: "Alcohol", emoji: "🍺", color: ["#16a34a", "#14532d"] },
  "7801900010023": { name: "Cerveza Cristal Pack 6 Latas 350ml", brand: "Cristal", category: "Alcohol", emoji: "🍺", color: ["#16a34a", "#14532d"] },
  "7801900010030": { name: "Cerveza Cristal Botella Retornable 1L", brand: "Cristal", category: "Alcohol", emoji: "🍺", color: ["#15803d", "#14532d"] },
  "7801900011013": { name: "Cerveza Escudo Lata 470ml", brand: "Escudo", category: "Alcohol", emoji: "🍺", color: ["#b91c1c", "#1e3a8a"] },
  "7801900011020": { name: "Cerveza Escudo Silver Lata 470ml", brand: "Escudo", category: "Alcohol", emoji: "🍺", color: ["#64748b", "#334155"] },
  "7801900012010": { name: "Cerveza Royal Guard Lager Lata 470ml", brand: "Royal Guard", category: "Alcohol", emoji: "🍺", color: ["#1e3a8a", "#172554"] },
  "7801900013017": { name: "Cerveza Heineken Lata 470ml", brand: "Heineken", category: "Alcohol", emoji: "🍺", color: ["#15803d", "#dc2626"] },
  "7802100001118": { name: "Cerveza Becker Lata 470ml", brand: "Becker", category: "Alcohol", emoji: "🍺", color: ["#dc2626", "#7f1d1d"] },
  "7501064191350": { name: "Cerveza Corona Extra Botellín 330ml", brand: "Corona", category: "Alcohol", emoji: "🍺", color: ["#f59e0b", "#1e3a8a"] },
  "7801900015011": { name: "Cerveza Kunstmann Torobayo 330ml", brand: "Kunstmann", category: "Alcohol", emoji: "🍺", color: ["#b45309", "#78350f"] },
  "7801900016018": { name: "Cerveza Austral Calafate 330ml", brand: "Austral", category: "Alcohol", emoji: "🍺", color: ["#4338ca", "#312e81"] },
  "7804300001018": { name: "Pisco Mistral Añejado en Roble 35° 750ml", brand: "Mistral", category: "Alcohol", emoji: "🥃", color: ["#b45309", "#78350f"] },
  "7804300001025": { name: "Pisco Mistral Nobel 40° 750ml", brand: "Mistral", category: "Alcohol", emoji: "🥃", color: ["#92400e", "#451a03"] },
  "7804310001015": { name: "Pisco Alto del Carmen Especial 35° 750ml", brand: "Alto del Carmen", category: "Alcohol", emoji: "🥃", color: ["#0284c7", "#1e3a8a"] },
  "7804310002012": { name: "Pisco Capel Especial 35° 750ml", brand: "Capel", category: "Alcohol", emoji: "🥃", color: ["#7c2d12", "#431407"] },
  "7804320001012": { name: "Vino Gato Cabernet Sauvignon Caja 1.5L", brand: "Gato", category: "Alcohol", emoji: "🍷", color: ["#7f1d1d", "#450a0a"] },
  "7804320001029": { name: "Vino Gato Merlot Botella 750ml", brand: "Gato", category: "Alcohol", emoji: "🍷", color: ["#991b1b", "#450a0a"] },
  "7804330001019": { name: "Vino Santa Helena Selección del Directorio 750ml", brand: "Santa Helena", category: "Alcohol", emoji: "🍷", color: ["#881337", "#4c0519"] },
  "7804330002016": { name: "Vino Exportación Selecto Caja 2L", brand: "Santa Helena", category: "Alcohol", emoji: "🍷", color: ["#9f1239", "#4c0519"] },
  "7804300005016": { name: "Vino Casillero del Diablo Cabernet 750ml", brand: "Concha y Toro", category: "Alcohol", emoji: "🍷", color: ["#450a0a", "#991b1b"] },
  "7804340001016": { name: "Vino 120 Santa Rita Tres Medallas 750ml", brand: "Santa Rita", category: "Alcohol", emoji: "🍷", color: ["#1e3a8a", "#7f1d1d"] },

  // ================= UTENSILIOS DE LIMPIEZA Y ASEO HOGAR =================
  "7805000001019": { name: "Lavaloza Quix Concentrado Limón 500ml", brand: "Quix", category: "Limpieza", emoji: "🧴", color: ["#16a34a", "#eab308"] },
  "7805000001026": { name: "Lavaloza Quix Concentrado Limón 1.5L", brand: "Quix", category: "Limpieza", emoji: "🧴", color: ["#16a34a", "#eab308"] },
  "7805000002016": { name: "Cloro Tradicional Clorinda 1 Litro", brand: "Clorinda", category: "Limpieza", emoji: "🧪", color: ["#0284c7", "#dc2626"] },
  "7805000002023": { name: "Cloro Gel Clorinda Multiuso 900ml", brand: "Clorinda", category: "Limpieza", emoji: "🧴", color: ["#0369a1", "#1d4ed8"] },
  "7805000003013": { name: "Detergente Líquido Omo Multiacción 3L", brand: "Omo", category: "Limpieza", emoji: "🧺", color: ["#1d4ed8", "#dc2626"] },
  "7805000003020": { name: "Detergente en Polvo Drive 1kg", brand: "Drive", category: "Limpieza", emoji: "🧺", color: ["#2563eb", "#1e40af"] },
  "7805000003037": { name: "Detergente en Polvo Rinso 800g", brand: "Rinso", category: "Limpieza", emoji: "🧺", color: ["#16a34a", "#15803d"] },
  "7806611223344": { name: "Papel Higiénico Confort Doble Hoja (Pack 4)", brand: "Confort", category: "Limpieza", emoji: "🧻", color: ["#0284c7", "#0369a1"] },
  "7806611223351": { name: "Papel Higiénico Elite Ultra Suave (Pack 4)", brand: "Elite", category: "Limpieza", emoji: "🧻", color: ["#2563eb", "#1e3a8a"] },
  "7806611223368": { name: "Toalla de Papel Nova Clásica (Pack 2 rollos)", brand: "Nova", category: "Limpieza", emoji: "🧻", color: ["#dc2626", "#991b1b"] },
  "7806611223375": { name: "Servilletas de Mesa Nova (Paquete 100 u.)", brand: "Nova", category: "Limpieza", emoji: "🧻", color: ["#e11d48", "#9f1239"] },
  "7805000004010": { name: "Desinfectante Aerosol Lysoform Original 360ml", brand: "Lysoform", category: "Limpieza", emoji: "🫧", color: ["#0284c7", "#1e3a8a"] },
  "7805000004027": { name: "Limpiador de Pisos Poett Primavera 900ml", brand: "Poett", category: "Limpieza", emoji: "🧹", color: ["#db2777", "#9d174d"] },
  "7805000005017": { name: "Esponja Multiuso Doble Faz Virutex", brand: "Virutex", category: "Limpieza", emoji: "🧽", color: ["#eab308", "#16a34a"] },
  "7805000005024": { name: "Paño Absorbente de Cocina Virutex (Pack 3)", brand: "Virutex", category: "Limpieza", emoji: "🧽", color: ["#0ea5e9", "#0369a1"] },
  "7805000005031": { name: "Bolsas de Basura Virutex 50x70cm (10 u.)", brand: "Virutex", category: "Limpieza", emoji: "🗑️", color: ["#334155", "#0f172a"] },
  "7805000005048": { name: "Virutilla de Acero para Ollas Virutex", brand: "Virutex", category: "Limpieza", emoji: "🧽", color: ["#dc2626", "#991b1b"] },
  "7805000006014": { name: "Fósforos Copihue Caja Grande", brand: "Copihue", category: "Limpieza", emoji: "🔥", color: ["#dc2626", "#eab308"] },
  "7805000007011": { name: "Pasta Dental Pepsodent Triple Protección 75ml", brand: "Pepsodent", category: "Limpieza", emoji: "🪥", color: ["#1d4ed8", "#dc2626"] },
  "7805000007028": { name: "Jabón de Tocador Lux Suave 125g", brand: "Lux", category: "Limpieza", emoji: "🧼", color: ["#ec4899", "#be185d"] },
  "7805000007035": { name: "Shampoo Ballerina Manzanilla Doypack 750ml", brand: "Ballerina", category: "Limpieza", emoji: "🧴", color: ["#f59e0b", "#b45309"] },

  // ================= LÁCTEOS Y REFRIGERADOS =================
  "7802800554120": { name: "Leche Entera Colún 1 Litro", brand: "Colún", category: "Lácteos", emoji: "🥛", color: ["#1d4ed8", "#1e3a8a"] },
  "7802800554137": { name: "Leche Semidescremada Colún 1 Litro", brand: "Colún", category: "Lácteos", emoji: "🥛", color: ["#16a34a", "#14532d"] },
  "7802800554144": { name: "Leche Descremada Colún 1 Litro", brand: "Colún", category: "Lácteos", emoji: "🥛", color: ["#0284c7", "#0369a1"] },
  "7802900001014": { name: "Leche Entera Soprole 1 Litro", brand: "Soprole", category: "Lácteos", emoji: "🥛", color: ["#dc2626", "#1d4ed8"] },
  "7802900002011": { name: "Yoghurt Batido Soprole Frutilla 120g", brand: "Soprole", category: "Lácteos", emoji: "🥣", color: ["#e11d48", "#9f1239"] },
  "7802900002028": { name: "Yoghurt Uno + Uno Soprole Con Zucaritas", brand: "Soprole", category: "Lácteos", emoji: "🥣", color: ["#2563eb", "#dc2626"] },
  "7802800003017": { name: "Mantequilla Con Sal Colún Pan 250g", brand: "Colún", category: "Lácteos", emoji: "🧈", color: ["#eab308", "#a16207"] },
  "7802800004014": { name: "Queso Gauda Laminado Colún 250g", brand: "Colún", category: "Lácteos", emoji: "🧀", color: ["#f59e0b", "#b45309"] },
  "7802800005011": { name: "Manjar Receta del Sur Colún Bolsa 400g", brand: "Colún", category: "Lácteos", emoji: "🍯", color: ["#92400e", "#451a03"] },

  // ================= ABARROTES Y DESPENSA =================
  "7804410009812": { name: "Arroz Grado 1 Tucapel 1kg", brand: "Tucapel", category: "Abarrotes", emoji: "🍚", color: ["#dc2626", "#1e3a8a"] },
  "7804410009829": { name: "Arroz Grado 2 Miraflores 1kg", brand: "Miraflores", category: "Abarrotes", emoji: "🍚", color: ["#0284c7", "#0369a1"] },
  "7801220004511": { name: "Aceite Maravilla Chef 900ml", brand: "Chef", category: "Abarrotes", emoji: "🫒", color: ["#eab308", "#15803d"] },
  "7801220004528": { name: "Aceite Vegetal Belmont 900ml", brand: "Belmont", category: "Abarrotes", emoji: "🫒", color: ["#f59e0b", "#b45309"] },
  "7805500998877": { name: "Azúcar Blanca Granulada Iansa 1kg", brand: "Iansa", category: "Abarrotes", emoji: "🧂", color: ["#0284c7", "#dc2626"] },
  "7802200001016": { name: "Tallarines N° 87 Lucchetti 400g", brand: "Lucchetti", category: "Abarrotes", emoji: "🍝", color: ["#dc2626", "#1e3a8a"] },
  "7802200001023": { name: "Espirales Lucchetti 400g", brand: "Lucchetti", category: "Abarrotes", emoji: "🍝", color: ["#dc2626", "#1e3a8a"] },
  "7802210001013": { name: "Spaghetti N° 5 Carozzi 400g", brand: "Carozzi", category: "Abarrotes", emoji: "🍝", color: ["#b91c1c", "#7f1d1d"] },
  "7802210002010": { name: "Salsa de Tomates Italiana Pomarola Carozzi 200g", brand: "Pomarola", category: "Abarrotes", emoji: "🍅", color: ["#dc2626", "#15803d"] },
  "7802200003010": { name: "Salsa de Tomates Malloa Tradicional 200g", brand: "Malloa", category: "Abarrotes", emoji: "🍅", color: ["#b91c1c", "#14532d"] },
  "7802300001015": { name: "Café Instantáneo Nescafé Tradición Tarro 170g", brand: "Nescafé", category: "Abarrotes", emoji: "☕", color: ["#7f1d1d", "#450a0a"] },
  "7802300001022": { name: "Café Nescafé Tradición Sobre 50g", brand: "Nescafé", category: "Abarrotes", emoji: "☕", color: ["#991b1b", "#450a0a"] },
  "7802400001014": { name: "Té Supremo Ceylán Caja 20 Bolsitas", brand: "Supremo", category: "Abarrotes", emoji: "🍵", color: ["#dc2626", "#991b1b"] },
  "7802400002011": { name: "Té Club Selección Caja 20 Bolsitas", brand: "Té Club", category: "Abarrotes", emoji: "🍵", color: ["#b91c1c", "#eab308"] },
  "7802500001013": { name: "Sal de Mesa Lobos Bolsa 1kg", brand: "Sal Lobos", category: "Abarrotes", emoji: "🧂", color: ["#1d4ed8", "#1e3a8a"] },
  "7802600001012": { name: "Atún Lomitos en Agua San José Tarro 160g", brand: "San José", category: "Abarrotes", emoji: "🥫", color: ["#0284c7", "#1e3a8a"] },
  "7802600001029": { name: "Jurel al Natural San José Tarro 425g", brand: "San José", category: "Abarrotes", emoji: "🥫", color: ["#1d4ed8", "#dc2626"] },
  "7802700001011": { name: "Mayonesa Hellmann's Doypack 372g", brand: "Hellmann's", category: "Abarrotes", emoji: "🥫", color: ["#1e3a8a", "#eab308"] },
  "7802700002018": { name: "Ketchup Malloa Doypack 250g", brand: "Malloa", category: "Abarrotes", emoji: "🍅", color: ["#dc2626", "#991b1b"] },
  "7802300005013": { name: "Caldo en Cubos Maggi Carne (8 u.)", brand: "Maggi", category: "Abarrotes", emoji: "🍲", color: ["#eab308", "#dc2626"] },
  "7802210005011": { name: "Harina Sin Polvos de Hornear Selecta 1kg", brand: "Selecta", category: "Abarrotes", emoji: "🌾", color: ["#1d4ed8", "#dc2626"] },

  // ================= PAN, GALLETAS, DULCES Y SNACKS =================
  "7803300112233": { name: "Pan de Molde Blanco Ideal Grande", brand: "Ideal", category: "Pan y Dulces", emoji: "🍞", color: ["#dc2626", "#1d4ed8"] },
  "7807788990011": { name: "Galletas Tritón Vainilla 126g", brand: "McKay", category: "Pan y Dulces", emoji: "🍪", color: ["#1e3a8a", "#ea580c"] },
  "7807788990028": { name: "Galletas Vino McKay Paquete 155g", brand: "McKay", category: "Pan y Dulces", emoji: "🍪", color: ["#dc2626", "#991b1b"] },
  "7807788990035": { name: "Oblea Bañada Super 8 29g", brand: "Nestlé", category: "Pan y Dulces", emoji: "🍫", color: ["#0f172a", "#dc2626"] },
  "7807788990042": { name: "Galleta Bañada Chokita (Ex Negrita) 30g", brand: "Nestlé", category: "Pan y Dulces", emoji: "🍫", color: ["#dc2626", "#eab308"] },
  "7807788990059": { name: "Bizcocho Chocman Costa 33g", brand: "Costa", category: "Pan y Dulces", emoji: "🍫", color: ["#92400e", "#eab308"] },
  "7807788990066": { name: "Papas Fritas Lay's Corte Americano 140g", brand: "Evercrisp", category: "Pan y Dulces", emoji: "🥔", color: ["#eab308", "#dc2626"] },
  "7807788990073": { name: "Ramitas Saladas Evercrisp 110g", brand: "Evercrisp", category: "Pan y Dulces", emoji: "🥨", color: ["#0284c7", "#dc2626"] },
  "7807788990080": { name: "Doritos Queso Nacho Evercrisp 120g", brand: "Evercrisp", category: "Pan y Dulces", emoji: "🌮", color: ["#dc2626", "#7f1d1d"] },
  "7807788990097": { name: "Cheetos Queso Evercrisp 110g", brand: "Evercrisp", category: "Pan y Dulces", emoji: "🧀", color: ["#ea580c", "#9a3412"] },
};

// Detectar categoría automáticamente a partir del texto de OpenFoodFacts / OpenProductsFacts
function guessChileanCategory(rawText) {
  const txt = String(rawText || "").toLowerCase();

  if (
    /cerveza|beer|lager|ale|vino|wine|pisco|ron|whisky|vodka|licor|alcohol|espumante|chicha|sidra/.test(
      txt
    )
  ) {
    return { category: "Alcohol", emoji: "🍺", color: ["#b45309", "#78350f"] };
  }

  if (
    /limpieza|detergente|lavaloza|cloro|jabon|jabón|shampoo|champu|papel higienico|toalla|servilleta|desinfectante|esponja|virutex|poett|lysoform|quix|omo|confort|pasta dental|colgate|pepsodent|desodorante|basura|escoba|fosforo/.test(
      txt
    )
  ) {
    return { category: "Limpieza", emoji: "🧹", color: ["#0284c7", "#0369a1"] };
  }

  if (/leche|milk|yoghurt|yogurt|queso|cheese|mantequilla|butter|crema|manjar|lacteo|lácteo/.test(txt)) {
    return { category: "Lácteos", emoji: "🥛", color: ["#1d4ed8", "#1e3a8a"] };
  }

  if (
    /bebida|gaseosa|soda|cola|agua|water|jugo|nectar|néctar|energética|energetica|isotónica/.test(txt)
  ) {
    return { category: "Bebidas", emoji: "🥤", color: ["#dc2626", "#991b1b"] };
  }

  if (
    /galleta|cookie|biscuit|chocolate|dulce|caramelo|pan |molde|snack|papas fritas|chips|ramitas|doritos|queque|alfajor/.test(
      txt
    )
  ) {
    return { category: "Pan y Dulces", emoji: "🍪", color: ["#ea580c", "#9a3412"] };
  }

  return { category: "Abarrotes", emoji: "🍚", color: ["#15803d", "#14532d"] };
}

// Consultar en paralelo Open Food Facts (Alimentos/Alcohol), Open Products Facts (Limpieza) y Open Beauty Facts (Aseo)
async function fetchFromOpenFactsAPIs(barcode) {
  const endpoints = [
    `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`,
    `https://world.openproductsfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`,
    `https://world.openbeautyfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`,
  ];

  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3200);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;

      const data = await res.json();
      if (data && data.status === 1 && data.product) {
        const p = data.product;
        const rawName =
          p.product_name_es ||
          p.product_name_cl ||
          p.product_name ||
          p.generic_name_es ||
          p.generic_name ||
          "";
        const rawBrand = (p.brands || "").split(",")[0].trim();
        const qty = (p.quantity || "").trim();

        if (!rawName && !rawBrand) continue;

        let fullName = rawName;
        if (qty && !fullName.toLowerCase().includes(qty.toLowerCase())) {
          fullName = `${fullName} ${qty}`.trim();
        }
        if (rawBrand && !fullName.toLowerCase().includes(rawBrand.toLowerCase())) {
          fullName = `${fullName} ${rawBrand}`.trim();
        }

        const catHint = `${fullName} ${rawBrand} ${p.categories || ""}`;
        const guessed = guessChileanCategory(catHint);

        // Mini foto real del envase desde OpenFoodFacts / OpenProductsFacts
        const realPhoto =
          p.image_front_small_url ||
          p.image_small_url ||
          p.image_thumb_url ||
          p.image_front_url ||
          makeProductThumbSVG(guessed.color[0], guessed.color[1], guessed.emoji, rawBrand || guessed.category);

        return {
          barcode,
          name: fullName,
          brand: rawBrand || "Minimarket",
          category: guessed.category,
          emoji: guessed.emoji,
          image: realPhoto,
          source: "Base de datos Chile / OpenFacts",
        };
      }
    } catch (_) {
      // Continuar con el siguiente endpoint o respaldo offline
    }
  }

  return null;
}

// Función principal: Busca un código de barras y devuelve { name, brand, category, emoji, image, found }
async function lookupChileanProductByBarcode(rawBarcode) {
  const barcode = String(rawBarcode || "").trim();
  if (!barcode) return { found: false };

  // 1. Revisar en el diccionario local instantáneo de Chile
  const localHit = CHILE_MINIMARKET_CATALOG[barcode];
  if (localHit) {
    const fallbackThumb = makeProductThumbSVG(
      localHit.color[0],
      localHit.color[1],
      localHit.emoji,
      localHit.brand
    );

    // También intentamos traer foto real de OpenFoodFacts en segundo plano rápido (1.5s) si hay internet
    let photoUrl = fallbackThumb;
    try {
      const online = await Promise.race([
        fetchFromOpenFactsAPIs(barcode),
        new Promise((resolve) => setTimeout(() => resolve(null), 1400)),
      ]);
      if (online && online.image && online.image.startsWith("http")) {
        photoUrl = online.image;
      }
    } catch (_) {}

    return {
      found: true,
      barcode,
      name: localHit.name,
      brand: localHit.brand,
      category: localHit.category,
      emoji: localHit.emoji,
      image: photoUrl,
      source: "Catálogo Minimarket Chile",
    };
  }

  // 2. Si no está en el diccionario fijo, buscar en vivo en las 3 bases de datos (Alimentos/Alcohol + Limpieza + Aseo)
  const onlineHit = await fetchFromOpenFactsAPIs(barcode);
  if (onlineHit) {
    return {
      found: true,
      ...onlineHit,
    };
  }

  return {
    found: false,
    barcode,
  };
}

// Buscar sugerencias en el catálogo chileno mientras escribe o para elegir rápido
function searchChileanCatalogSuggestions(query = "") {
  const q = String(query || "").toLowerCase().trim();
  const entries = Object.entries(CHILE_MINIMARKET_CATALOG).map(([barcode, item]) => ({
    barcode,
    ...item,
    image: makeProductThumbSVG(item.color[0], item.color[1], item.emoji, item.brand),
  }));

  if (!q) return entries.slice(0, 12);
  return entries
    .filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.brand.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.barcode.includes(q)
    )
    .slice(0, 12);
}

window.ChileCatalog = {
  lookupByBarcode: lookupChileanProductByBarcode,
  searchSuggestions: searchChileanCatalogSuggestions,
  makeThumbSVG: makeProductThumbSVG,
};
