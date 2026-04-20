/* ============================================
   L'Oréal Oré — Smart Routine & Product Advisor
   ============================================ */

/* ---------- DOM references ---------- */
const categoryFilter = document.getElementById("categoryFilter");
const productSearch = document.getElementById("productSearch");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const productsContainer = document.getElementById("productsContainer");
const expandControl = document.getElementById("expandControl");
const expandBtn = document.getElementById("expandBtn");
const expandBtnLabel = document.getElementById("expandBtnLabel");
const expandBtnIcon = document.getElementById("expandBtnIcon");
const selectedProductsList = document.getElementById("selectedProductsList");
const clearSelectionsBtn = document.getElementById("clearSelections");
const generateRoutineBtn = document.getElementById("generateRoutine");
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");
const chatWindow = document.getElementById("chatWindow");

/* ---------- State ---------- */

/* Map<number, product> — stores every product the user has clicked/selected.
   Keyed by product.id so lookups & toggles are O(1). The FULL product object
   (including the `description` field) is stored, so the AI later has the
   richest possible context when generating a routine. */
const selectedProducts = new Map();

/* Cache of all loaded products so we only fetch products.json once. */
let allProducts = [];

/* How many cards to show before the user taps "View More". */
const INITIAL_VISIBLE_COUNT = 6;
let isExpanded = false;
let currentFilteredProducts = [];
let currentSearchTerm = "";

/* Conversation history for the chat — sent with every API request. */
const messages = [];

/* Cloudflare Worker endpoint (replace with your own). */
const API_URL = "https://loreal-routine-builder.jloops.workers.dev/";

/* ---------- Persistence (localStorage) ---------- */

/* Bumping this key if the stored shape ever changes lets us invalidate
   old saves without colliding with other apps on the same origin. */
const STORAGE_KEY = "loreal-advisor:selected:v1";

/* Serialize the Map's values (full product objects) to localStorage.
   Wrapped in try/catch because localStorage can throw in private-mode
   browsers, when quota is exceeded, or when the user has cookies disabled. */
function saveSelections() {
  try {
    const arr = Array.from(selectedProducts.values());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (err) {
    console.warn("Could not save selections:", err);
  }
}

/* Pull any saved selections back into the Map on page load.
   Runs synchronously before first render so the chips appear immediately
   without waiting on products.json. */
function loadSelections() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    arr.forEach((p) => {
      if (p && typeof p.id === "number") {
        selectedProducts.set(p.id, p);
      }
    });
  } catch (err) {
    /* If the stored JSON is corrupt, wipe it so we don't keep hitting this. */
    console.warn("Could not load selections, clearing:", err);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
  }
}

/* Restore on startup, BEFORE the first renderSelectedList() call below. */
loadSelections();

/* ---------- Direction (LTR / RTL) ---------- */

/* Auto-detect direction from the user's browser language preferences.
   When any of the browser's preferred languages is RTL (Arabic, Hebrew,
   Persian, Urdu, etc.) we set dir="rtl" on <html> and CSS logical
   properties do the rest.

   The list below covers the major living RTL scripts recognized by the
   Unicode CLDR. We normalize to the primary subtag so "ar-EG", "he-IL",
   etc. all match. Legacy ISO codes ("iw" for Hebrew, "ji" for Yiddish)
   are included for older browsers that still return them. */
(function detectAndApplyDirection() {
  const RTL_LANGS = new Set([
    "ar", // Arabic
    "arc", // Aramaic
    "ckb", // Central Kurdish (Sorani)
    "dv", // Divehi (Maldivian)
    "fa", // Persian / Farsi
    "ha", // Hausa (when written in Ajami script)
    "he", // Hebrew
    "iw", // Hebrew (legacy code)
    "khw", // Khowar
    "ks", // Kashmiri
    "ku", // Kurdish
    "ps", // Pashto
    "sd", // Sindhi
    "ur", // Urdu
    "uz-AF", // Uzbek (Afghanistan) — matches on "uz" below
    "yi", // Yiddish
    "ji", // Yiddish (legacy code)
  ]);

  const langs = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || "en"];

  const isRtl = langs.some((l) => {
    if (!l) return false;
    const primary = l.toLowerCase().split(/[-_]/)[0];
    return RTL_LANGS.has(primary);
  });

  document.documentElement.setAttribute("dir", isRtl ? "rtl" : "ltr");
})();

/* ---------- Initial UI ---------- */
function showPlaceholder() {
  productsContainer.innerHTML = `
    <div class="placeholder-message">
      Select a category to view products
    </div>
  `;
  expandControl.hidden = true;
}
showPlaceholder();

/* ---------- Load product data ---------- */
async function loadProducts() {
  if (allProducts.length) return allProducts;
  const response = await fetch("products.json");
  const data = await response.json();
  allProducts = data.products;
  return allProducts;
}

/* ---------- Render products grid ---------- */
function renderProducts() {
  if (!currentFilteredProducts.length) {
    const msg = currentSearchTerm
      ? `No products match "${escapeHtml(currentSearchTerm)}"`
      : "No products found in this category";
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        ${msg}
      </div>
    `;
    expandControl.hidden = true;
    return;
  }

  /* Slice based on expanded state */
  const visible = isExpanded
    ? currentFilteredProducts
    : currentFilteredProducts.slice(0, INITIAL_VISIBLE_COUNT);

  productsContainer.innerHTML = visible
    .map((product) => {
      const isSelected = selectedProducts.has(product.id);
      return `
        <div
          class="product-card ${isSelected ? "selected" : ""}"
          data-id="${product.id}"
          role="button"
          tabindex="0"
          aria-pressed="${isSelected}"
        >
          <div class="check-badge" aria-hidden="true">
            <span class="material-icons">check</span>
          </div>
          <img src="${product.image}" alt="${product.name}" />
          <div class="brand">${product.brand}</div>
          <h3>${product.name}</h3>
          <p class="short-desc">${product.description}</p>
          <div class="full-desc">${product.description}</div>
        </div>
      `;
    })
    .join("");

  /* Show / hide the expand control */
  if (currentFilteredProducts.length > INITIAL_VISIBLE_COUNT) {
    expandControl.hidden = false;
    expandBtnLabel.textContent = isExpanded ? "View Less" : "View More";
    expandBtnIcon.textContent = isExpanded ? "expand_less" : "expand_more";
  } else {
    expandControl.hidden = true;
  }
}

/* ---------- Toggle product selection ---------- */
function toggleProduct(productId) {
  if (selectedProducts.has(productId)) {
    /* REMOVING — we already have the full product object in the Map,
       so no lookup into allProducts is needed. This also means chips
       restored from localStorage can be removed before the user has
       picked a category (i.e. before products.json has loaded). */
    selectedProducts.delete(productId);
  } else {
    /* ADDING — need the product data from the loaded catalog. */
    const product = allProducts.find((p) => p.id === productId);
    if (!product) return;
    selectedProducts.set(productId, product);
  }

  saveSelections();
  renderProducts();
  renderSelectedList();
}

/* ---------- Render selected products chips ---------- */
function renderSelectedList() {
  if (selectedProducts.size === 0) {
    selectedProductsList.innerHTML = `
      <div class="selected-empty">No products selected yet — tap a card above to add it.</div>
    `;
    clearSelectionsBtn.hidden = true;
    generateRoutineBtn.disabled = true;
    return;
  }

  clearSelectionsBtn.hidden = false;
  generateRoutineBtn.disabled = false;

  const chips = Array.from(selectedProducts.values())
    .map(
      (p) => `
        <div class="selected-chip" data-id="${p.id}">
          <span>${p.name}</span>
          <button
            type="button"
            class="chip-remove"
            data-id="${p.id}"
            aria-label="Remove ${p.name}"
          >
            <span class="material-icons">close</span>
          </button>
        </div>
      `
    )
    .join("");

  selectedProductsList.innerHTML = chips;
}
renderSelectedList();

/* ---------- Unified filter: category + search ---------- */

/* Small util to safely display user-typed text inside innerHTML
   (only used in the "No products match …" empty-state message). */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Runs the combined filter whenever either input changes.
   - No category AND no search → placeholder.
   - Either one active → filter against it.
   - Both active → intersection (category AND search match).
   Search matches against name, brand, category, and description so
   keyword hunts like "retinol" or "sensitive skin" find products
   even when the word doesn't appear in the product's name. */
async function applyFilters() {
  const category = categoryFilter.value;
  const query = currentSearchTerm.trim().toLowerCase();

  /* Nothing active — show the welcome placeholder. */
  if (!category && !query) {
    showPlaceholder();
    return;
  }

  /* Make sure the catalog is loaded (idempotent — cached after first call). */
  const products = await loadProducts();

  let results = products;

  if (category && category !== "all") {
    results = results.filter((p) => p.category === category);
  }

  if (query) {
    results = results.filter((p) => {
      const haystack = [p.name, p.brand, p.category, p.description]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  currentFilteredProducts = results;
  /* Collapse back to the initial view whenever filters change so the
     user sees the top matches first. */
  isExpanded = false;
  renderProducts();
}

/* ---------- Event: category changes ---------- */
categoryFilter.addEventListener("change", applyFilters);

/* ---------- Event: search typing ---------- */
productSearch.addEventListener("input", (e) => {
  currentSearchTerm = e.target.value;
  clearSearchBtn.hidden = currentSearchTerm.length === 0;
  applyFilters();
});

/* ---------- Event: clear the search field ---------- */
clearSearchBtn.addEventListener("click", () => {
  productSearch.value = "";
  currentSearchTerm = "";
  clearSearchBtn.hidden = true;
  productSearch.focus();
  applyFilters();
});

/* ---------- Event: click on product card (delegated) ---------- */
productsContainer.addEventListener("click", (e) => {
  const card = e.target.closest(".product-card");
  if (!card) return;
  const id = Number(card.dataset.id);
  toggleProduct(id);
});

/* Keyboard a11y — space / enter toggles the card */
productsContainer.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".product-card");
  if (!card) return;
  e.preventDefault();
  const id = Number(card.dataset.id);
  toggleProduct(id);
});

/* ---------- Event: expand / collapse ---------- */
expandBtn.addEventListener("click", () => {
  isExpanded = !isExpanded;
  renderProducts();
});

/* ---------- Event: remove chip ---------- */
selectedProductsList.addEventListener("click", (e) => {
  const removeBtn = e.target.closest(".chip-remove");
  if (!removeBtn) return;
  const id = Number(removeBtn.dataset.id);
  toggleProduct(id);
});

/* ---------- Event: clear all selections ---------- */
clearSelectionsBtn.addEventListener("click", () => {
  selectedProducts.clear();
  saveSelections();
  renderProducts();
  renderSelectedList();
});

/* ============================================
   CHAT
   ============================================ */

function addMessage(role, text) {
  const div = document.createElement("div");
  div.classList.add("msg", role === "user" ? "user" : "ai");
  div.textContent = role === "user" ? `You: ${text}` : `Oré: ${text}`;
  chatWindow.appendChild(div);
  scrollToBottom();
  return div;
}

function streamText(element, fullText, wordsPerTick = 2) {
  return new Promise((resolve) => {
    const words = fullText.split(" ");
    let index = 0;
    element.textContent = "Oré: ";
    const interval = setInterval(() => {
      const chunk = words.slice(index, index + wordsPerTick).join(" ");
      element.textContent += (index > 0 ? " " : "") + chunk;
      index += wordsPerTick;
      scrollToBottom();
      if (index >= words.length) {
        clearInterval(interval);
        resolve();
      }
    }, 45);
  });
}

function scrollToBottom() {
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function showTyping() {
  const div = document.createElement("div");
  div.classList.add("msg", "ai", "typing-indicator");
  div.innerHTML = "Oré is thinking<span class='dot-pulse'>...</span>";
  chatWindow.appendChild(div);
  scrollToBottom();
  return div;
}

/* Build a "Sources" panel under an AI message from the API's annotations.
   Uses DOM methods (not innerHTML) so URLs/titles from the search tool
   can't be interpreted as markup. Deduplicates by URL. */
function renderCitations(container, annotations) {
  if (!annotations || !annotations.length) return;

  const seen = new Set();
  const cites = [];
  for (const a of annotations) {
    if (a?.type !== "url_citation" || !a.url_citation) continue;
    const { url, title } = a.url_citation;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    cites.push({ url, title: title || url });
  }
  if (!cites.length) return;

  const wrap = document.createElement("div");
  wrap.className = "citations";

  const label = document.createElement("div");
  label.className = "citations-label";
  label.textContent = `Sources (${cites.length})`;
  wrap.appendChild(label);

  const list = document.createElement("ol");
  list.className = "citations-list";
  cites.forEach(({ url, title }) => {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = title;
    li.appendChild(link);
    list.appendChild(li);
  });
  wrap.appendChild(list);

  container.appendChild(wrap);
}

function setInputLocked(locked) {
  userInput.disabled = locked;
  document.getElementById("sendBtn").disabled = locked;
  if (!locked) userInput.focus();
}

async function sendMessage(userText) {
  messages.push({ role: "user", content: userText });
  addMessage("user", userText);
  setInputLocked(true);
  const typingEl = showTyping();

  /* Trim selected products down to the fields the AI actually needs.
     The worker injects these into the system prompt so the model has
     persistent awareness of the user's selections across turns. */
  const selectedForAI = Array.from(selectedProducts.values()).map((p) => ({
    name: p.name,
    brand: p.brand,
    category: p.category,
    description: p.description,
  }));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        selectedProducts: selectedForAI,
      }),
    });
    if (!response.ok) throw new Error(`Server responded with ${response.status}`);

    const data = await response.json();
    const aiMsg = data.choices[0].message;
    const aiText = aiMsg.content;
    /* Search-enabled responses include an `annotations` array with
       url_citation entries — each has a title and url we can render. */
    const annotations = Array.isArray(aiMsg.annotations)
      ? aiMsg.annotations
      : [];
    messages.push({ role: "assistant", content: aiText });

    typingEl.remove();
    const aiDiv = document.createElement("div");
    aiDiv.classList.add("msg", "ai");
    chatWindow.appendChild(aiDiv);
    await streamText(aiDiv, aiText);

    /* After streaming finishes, append any citations as clickable links. */
    renderCitations(aiDiv, annotations);
    scrollToBottom();
  } catch (error) {
    typingEl.remove();
    addMessage(
      "assistant",
      "I'm sorry, something went wrong. Please try again."
    );
    console.error("Chat error:", error);
  } finally {
    setInputLocked(false);
  }
}

/* Initial greeting */
chatWindow.innerHTML = "";
addMessage(
  "assistant",
  "Hello! I'm Oré, your personal beauty advisor. Select a few products above and I'll build you a routine — or just ask me anything about skincare, haircare, or makeup."
);

/* Handle form submit */
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  userInput.value = "";
  sendMessage(text);
});

/* ---------- Generate Routine ---------- */
generateRoutineBtn.addEventListener("click", () => {
  if (selectedProducts.size === 0) return;

  /* No need to dump the full product list into the user message —
     the worker already receives `selectedProducts` on every request
     and injects them into the system prompt. A short, clear user-side
     prompt is enough to kick off routine generation. */
  const count = selectedProducts.size;
  sendMessage(
    `Please build me a personalized beauty routine using the ${count} product${count === 1 ? "" : "s"} I've selected. Walk me through the order of use, AM vs PM, and any tips I should know.`
  );
});
