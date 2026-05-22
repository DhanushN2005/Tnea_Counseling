const API_URL = "";
let sessionId = uuidv4();
let currentTab = "chat";
let previousTab = "chat";
let currentTier = "safe";
let allRecommendations = [];
let directoryColleges = [];
let tfcCenters = [];
let directoryDebounceTimeout = null;

// Initialize
document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    setupEventListeners();
    updateSidebarInfo();
});

function initTheme() {
    const savedTheme = localStorage.getItem("theme") || "dark";
    if (savedTheme === "light") {
        document.body.classList.add("light-theme");
        updateThemeUI(true);
    }
}

function updateThemeUI(isLight) {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const icon = btn.querySelector("i");
    const label = btn.querySelector(".label");
    
    if (isLight) {
        icon.className = "fas fa-sun";
        label.textContent = "Light Mode";
    } else {
        icon.className = "fas fa-moon";
        label.textContent = "Dark Mode";
    }
}

function setupEventListeners() {
    // Theme Toggle
    document.getElementById("theme-toggle").addEventListener("click", () => {
        const isLight = document.body.classList.toggle("light-theme");
        localStorage.setItem("theme", isLight ? "light" : "dark");
        updateThemeUI(isLight);
    });

    // Navigation
    const sidebar = document.querySelector(".sidebar");
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", () => {
            if (item.id === "theme-toggle") return;
            document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
            item.classList.add("active");
            switchTab(item.dataset.tab);
            
            // Mobile close
            if (window.innerWidth <= 1024) {
                sidebar.classList.remove("open");
            }
        });
    });

    // Mobile Sidebar Toggle
    const mobileToggle = document.getElementById("mobile-toggle");
    if (mobileToggle) {
        mobileToggle.addEventListener("click", () => {
            sidebar.classList.toggle("open");
        });
    }

    // Chat
    document.getElementById("send-btn").addEventListener("click", sendMessage);
    document.getElementById("chat-input").addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendMessage();
    });

    // Finder
    document.getElementById("find-colleges-btn").addEventListener("click", findColleges);
    
    // Tabs
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentTier = btn.dataset.tier;
            renderRecommendations();
        });
    });

    // Clear Memory
    const clearMemoryBtn = document.getElementById("clear-memory");
    if (clearMemoryBtn) {
        clearMemoryBtn.addEventListener("click", () => {
            sessionId = uuidv4();
            document.getElementById("chat-container").innerHTML = `
                <div class="chat-message bot">
                    <div class="message-content">Memory cleared. How can I help you today?</div>
                </div>
            `;
        });
    }

    // Back Button
    document.getElementById("back-btn").addEventListener("click", () => {
        switchTab(previousTab);
    });

    // PDF / Print Choice List Export
    const exportPdfBtn = document.getElementById("export-pdf-btn");
    if (exportPdfBtn) {
        exportPdfBtn.addEventListener("click", () => {
            window.print();
        });
    }

    // Preset Prompt Click event listeners
    document.querySelectorAll(".preset-card").forEach(card => {
        card.addEventListener("click", () => {
            const prompt = card.dataset.prompt;
            const input = document.getElementById("chat-input");
            if (input) {
                input.value = prompt;
                sendMessage();
            }
        });
    });

    // Directory Search (Debounced Server-Side Search)
    const directorySearch = document.getElementById("directory-search");
    if (directorySearch) {
        directorySearch.addEventListener("input", (e) => {
            const term = e.target.value.trim();
            
            clearTimeout(directoryDebounceTimeout);
            directoryDebounceTimeout = setTimeout(() => {
                loadDirectory(term);
            }, 300);
        });
    }

    // TFC Search
    const tfcSearch = document.getElementById("tfc-search");
    if (tfcSearch) {
        tfcSearch.addEventListener("input", (e) => {
            const term = e.target.value.toLowerCase().trim();
            if (!term) {
                renderTFC(tfcCenters);
                return;
            }
            
            // Multi-token robust search for TFC centers
            const tokens = term.split(/\s+/).filter(t => t.length > 0);
            if (tokens.length === 0) {
                renderTFC(tfcCenters);
                return;
            }

            const filtered = tfcCenters.filter(t => {
                return tokens.every(token => {
                    const nameAddressMatch = t.name_address ? t.name_address.toLowerCase().includes(token) : false;
                    const districtMatch = t.district ? t.district.toLowerCase().includes(token) : false;
                    const coordinatorMatch = t.coordinator ? t.coordinator.toLowerCase().includes(token) : false;
                    return nameAddressMatch || districtMatch || coordinatorMatch;
                });
            });
            renderTFC(filtered);
        });
    }
}

function switchTab(tabId) {
    if (currentTab !== "profile") previousTab = currentTab;
    currentTab = tabId;
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById(`${tabId}-view`).classList.add("active");
    
    if (tabId === "directory") {
        const searchInput = document.getElementById("directory-search");
        if (searchInput) searchInput.value = "";
        loadDirectory();
    }
    if (tabId === "tfc") {
        const searchInput = document.getElementById("tfc-search");
        if (searchInput) searchInput.value = "";
        loadTFC();
    }
    if (tabId === "choices") loadChoices();
}

async function sendMessage() {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;

    appendMessage("user", text);
    input.value = "";

    const loadingId = appendLoadingMessage();
    
    try {
        const response = await fetch(`${API_URL}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: text,
                session_id: sessionId,
                cutoff: parseFloat(document.getElementById("input-cutoff").value),
                category: document.getElementById("input-category").value
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(JSON.stringify(errorData.detail) || "Server error");
        }

        const data = await response.json();
        removeLoadingMessage(loadingId);

        let answerText = data.answer;
        // Parse 10-digit phone numbers and replace with clickable tel links
        answerText = answerText.replace(/\b\d{10}\b/g, (match) => {
            return `<a href="tel:${match}" class="chat-callable-link"><i class="fas fa-phone-alt"></i> ${match}</a>`;
        });

        let htmlContent = marked.parse(answerText);
        
        if (data.strategy_alert) {
            const alertHtml = `<div class="strategy-alert">
                <span class="strategy-alert-icon"><i class="fas fa-lightbulb"></i></span>
                <div>
                    <b class="strategy-alert-title">Strategy Tip</b>
                    <span class="strategy-alert-body">${data.strategy_alert}</span>
                </div>
            </div>`;
            htmlContent = alertHtml + htmlContent;
        }

        const cleanSources = (data.sources || []).filter(s => s && !s.includes("Page None"));
        if (cleanSources.length > 0) {
            const sourcePills = cleanSources.map(s => {
                const label = s.replace(/ \(Page .*?\)/, "");
                return `<span class="source-pill"><i class="fas fa-book-open"></i> ${label}</span>`;
            }).join("");
            htmlContent += `<div class="sources-block">${sourcePills}</div>`;
        }

        appendMessage("bot", htmlContent);
    } catch (error) {
        removeLoadingMessage(loadingId);
        appendMessage("bot", "Sorry, I encountered a connection error. Please make sure the backend is running.");
    }
}

async function findColleges() {
    const rawCutoff = document.getElementById("input-cutoff").value;
    const cutoff = parseFloat(rawCutoff) || 0.0;
    const category = document.getElementById("input-category").value || "OC";
    const district = document.getElementById("input-district").value;
    const branch = document.getElementById("input-branch").value;

    showLoader(true);
    updateSidebarInfo();

    try {
        const response = await fetch(`${API_URL}/recommend`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cutoff,
                category,
                district,
                branch,
                session_id: sessionId
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(JSON.stringify(errorData.detail) || "Server error");
        }

        allRecommendations = await response.json();
        renderRecommendations();
    } catch (error) {
        console.error(error);
        showToast("Error: " + error.message, "error");
    } finally {
        showLoader(false);
    }
}

function renderRecommendations() {
    const container = document.getElementById("results-container");
    container.innerHTML = "";

    const filtered = allRecommendations.filter(r => r.tier.toLowerCase() === currentTier);

    if (filtered.length === 0) {
        let label = currentTier === 'safe' ? 'High Probability' : (currentTier === 'moderate' ? 'Good Match' : 'Aspirational Reach');
        container.innerHTML = `<div class="empty-state">No ${label} colleges found. Try adjusting your filters or checking other categories.</div>`;
        return;
    }

    filtered.forEach(rec => {
        const card = document.createElement("div");
        card.className = `college-card ${currentTier}`;
        
        const badgeClass = currentTier === "safe" ? "safe-badge" : 
                          currentTier === "moderate" ? "moderate-badge" : "dream-badge";
        
        let historyHtml = "";
        if (rec.history) {
            historyHtml = `
                <div class="stats-dashboard">
                    <div class="stat-item"><span>'21</span><b>${rec.history["2021"] || '-'}</b></div>
                    <div class="stat-item"><span>'22</span><b>${rec.history["2022"] || '-'}</b></div>
                    <div class="stat-item"><span>'23</span><b>${rec.history["2023"] || '-'}</b></div>
                    <div class="stat-item"><span>'24</span><b>${rec.history["2024"] || '-'}</b></div>
                    <div class="stat-item highlighted"><span>'25</span><b>${rec.history["2025"] || '-'}</b></div>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="card-header">
                <div class="card-badge ${badgeClass}">
                    <i class="fas ${currentTier === 'safe' ? 'fa-check-circle' : 'fa-info-circle'}"></i>
                    ${rec.label || rec.tier}
                </div>
                <div class="college-code-badge">CODE: ${rec.college_code}</div>
            </div>
            
            <div class="college-info">
                <h4>${rec.college_name}</h4>
                <div class="location-tag"><i class="fas fa-map-marker-alt"></i> ${rec.district}</div>
            </div>

            <div class="branch-highlight">
                <div class="branch-label">Preferred Branch</div>
                <div class="branch-name">${rec.branch_name}</div>
            </div>
            
            ${historyHtml}
            
            <div class="ai-insight">
                <i class="fas fa-magic"></i>
                <p>"${rec.reason}"</p>
            </div>

            <div class="card-actions">
                <button class="btn-secondary add-choice-btn"><i class="fas fa-plus"></i> Add to List</button>
                <button class="btn-primary view-profile-btn">Full Profile <i class="fas fa-arrow-right"></i></button>
            </div>
        `;

        card.querySelector(".view-profile-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            showProfile(rec.college_code || "0000");
        });

        card.querySelector(".add-choice-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            addToChoice({
                code: rec.college_code || "0000",
                name: rec.college_name || "Unknown College",
                branch: rec.branch_name || "General",
                district: rec.district || "Unknown"
            });
        });
        
        container.appendChild(card);
    });
}

async function loadDirectory(searchQuery = "") {
    const container = document.getElementById("directory-container");

    // Only show "Fetching" if there is no cache or we are running a search
    if (directoryColleges.length === 0 || searchQuery) {
        container.innerHTML = '<div class="empty-state">Fetching historical trends...</div>';
    }

    try {
        const url = searchQuery 
            ? `${API_URL}/directory?search=${encodeURIComponent(searchQuery)}`
            : `${API_URL}/directory`;
        const response = await fetch(url);
        const data = await response.json();
        const colleges = data.colleges || data;
        
        if (!searchQuery) {
            directoryColleges = colleges;
        }
        renderDirectory(colleges);
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Error loading directory.</div>';
    }
}

function renderDirectory(data) {
    const container = document.getElementById("directory-container");
    container.innerHTML = "";

    if (data.length === 0) {
        container.innerHTML = '<div class="empty-state">No historical data available yet.</div>';
        return;
    }

    data.forEach(item => {
        const card = document.createElement("div");
        card.className = "college-card";
        
        const branchesHtml = item.branches.map(b => `
            <div class="branch-summary-row">
                <div class="branch-info-mini">
                    <div class="branch-title-mini">${b.name}</div>
                </div>
                <div class="branch-range-badge">${b.min} - ${b.max}</div>
            </div>
        `).join("");

        card.innerHTML = `
            <div class="card-header">
                <div class="college-code-badge">CODE: ${item.code}</div>
                <div class="location-tag"><i class="fas fa-map-marker-alt"></i> ${item.district}</div>
            </div>
            
            <div class="college-info" style="margin-top: 0.5rem;">
                <h4>${item.name}</h4>
            </div>
            
            <div class="directory-branch-list">
                <div class="section-label"><i class="fas fa-list-ul"></i> Cutoff History Ranges</div>
                <div class="branch-scroll-area">
                    ${branchesHtml}
                </div>
            </div>
            
            <div class="card-actions">
                <button class="btn-secondary add-choice-btn"><i class="fas fa-plus"></i> Add</button>
                <button class="btn-primary view-profile-btn">Full Profile <i class="fas fa-arrow-right"></i></button>
            </div>
        `;

        card.querySelector(".view-profile-btn").addEventListener("click", () => showProfile(item.code || "0000"));
        card.querySelector(".add-choice-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            addToChoice({
                code: item.code || "0000",
                name: item.name || "Unknown",
                branch: "Multiple Branches",
                district: item.district || "Unknown"
            });
        });
        container.appendChild(card);
    });
}


async function showProfile(code) {
    showLoader(true);
    try {
        const response = await fetch(`${API_URL}/college/${code}`);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "College details not available");
        }
        const data = await response.json();
        
        switchTab("profile");
        document.getElementById("profile-name").textContent = data.name || "TNEA College";
        document.getElementById("profile-subtitle").textContent = `${data.district || 'N/A'} | Code: ${data.code || code} | Type: ${data.category_type || 'N/A'}`;
        
        const content = document.getElementById("profile-content");
        content.innerHTML = "";

        // 1. Historical Trends Section
        if (data.historical_trends && data.historical_trends.length > 0) {
            const trendSection = document.createElement("div");
            trendSection.className = "finder-form-card";
            trendSection.style.marginBottom = "2rem";
            trendSection.style.borderLeft = "4px solid var(--primary)";
            
            let trendHtml = data.historical_trends.map(t => `
                <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; margin-bottom: 1rem;">
                    ${t}
                </div>
            `).join("");

            trendSection.innerHTML = `
                <h3 style="margin-bottom: 1rem; color: var(--primary); font-size: 1.2rem;"><i class="fas fa-chart-area"></i> Historical Cutoff Trends (RAG Data)</h3>
                <div class="trend-list">
                    ${trendHtml}
                </div>
            `;
            content.appendChild(trendSection);
        }

        // 2. Current Cutoffs Section (Updated for Multi-year)
        const branches = data.branches || {};
        if (Object.keys(branches).length === 0) {
            const emptySection = document.createElement("div");
            emptySection.className = "empty-state";
            emptySection.style.cssText = "background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.1); padding: 3rem; text-align: center; border-radius: 12px; margin-bottom: 2rem;";
            emptySection.innerHTML = `
                <i class="fas fa-database" style="font-size: 2rem; margin-bottom: 1rem; opacity: 0.5; color: var(--primary);"></i>
                <p style="color: var(--text-main); font-weight: 600;">No Detailed Branch Data</p>
                <p style="font-size: 0.85rem; color: var(--text-dim); margin-top: 0.5rem;">The SQL database doesn't have course-specific cutoffs for this code. Please refer to the <b>Knowledge Records</b> section for raw historical notes.</p>
            `;
            content.appendChild(emptySection);
        }

        for (const [branch, categories] of Object.entries(branches)) {
            const branchSection = document.createElement("div");
            branchSection.className = "finder-form-card";
            branchSection.style.marginBottom = "1.5rem";
            branchSection.style.padding = "1.5rem";
            branchSection.style.overflowX = "auto";
            
            let categoryRows = Object.entries(categories).map(([cat, years]) => `
                <tr>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); font-weight: 600;">${cat}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-dim);">${years["2021"] || '-'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-dim);">${years["2022"] || '-'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-dim);">${years["2023"] || '-'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-dim);">${years["2024"] || '-'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--primary); font-weight: 700;">${years["2025"] || '-'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-dim);">Available</td>
                </tr>
            `).join("");

            branchSection.innerHTML = `
                <h3 style="margin-bottom: 1rem; color: var(--text-main); font-size: 1.1rem;">${branch}</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
                    <thead>
                        <tr style="color: var(--text-dim); border-bottom: 2px solid var(--primary-glow);">
                            <th style="padding: 0.5rem;">Category</th>
                            <th style="padding: 0.5rem;">2021</th>
                            <th style="padding: 0.5rem;">2022</th>
                            <th style="padding: 0.5rem;">2023</th>
                            <th style="padding: 0.5rem;">2024</th>
                            <th style="padding: 0.5rem; color: var(--primary);">2025</th>
                            <th style="padding: 0.5rem;">Seats</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${categoryRows}
                    </tbody>
                </table>
            `;
            content.appendChild(branchSection);
        }
    } catch (error) {
        console.error("Profile Load Error:", error);
        showToast(`Failed to load profile: ${error.message}`, "error");
    } finally {
        showLoader(false);
    }
}

async function addToChoice(data) {
    try {
        const response = await fetch(`${API_URL}/choice/add?session_id=${sessionId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const resData = await response.json();
        document.getElementById("choice-count").textContent = resData.count;
        showToast(`Added ${data.name} (${data.branch}) to Choice List!`, "success");
    } catch (error) {
        showToast("Failed to add college to Choice List.", "error");
    }
}

async function loadChoices() {
    const container = document.getElementById("choices-container");
    container.innerHTML = '<div class="empty-state">Loading your choices...</div>';

    try {
        const response = await fetch(`${API_URL}/choice/${sessionId}`);
        const choices = await response.json();
        
        container.innerHTML = "";
        if (choices.length === 0) {
            container.innerHTML = '<div class="empty-state">Your choice list is empty. Add colleges from the Finder or Directory.</div>';
            return;
        }

        choices.forEach((c, index) => {
            const card = document.createElement("div");
            card.className = "college-card choice-item";
            card.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 1.25rem;">
                    <div style="display: flex; align-items: center; gap: 1.25rem; flex: 1;">
                        <div class="choice-index" style="background: var(--primary); width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; flex-shrink: 0; box-shadow: 0 4px 10px var(--primary-glow);">${index + 1}</div>
                        <div style="flex: 1;">
                            <h4 style="margin-bottom: 0.35rem; font-size: 1.05rem;">${c.name}</h4>
                            <div class="location-tag" style="display: flex; flex-wrap: wrap; gap: 0.8rem; font-size: 0.78rem;">
                                <span><i class="fas fa-university"></i> CODE: ${c.code}</span>
                                <span>&bull;</span>
                                <span><i class="fas fa-graduation-cap"></i> ${c.branch}</span>
                                <span>&bull;</span>
                                <span><i class="fas fa-map-marker-alt"></i> ${c.district || 'Tamil Nadu'}</span>
                            </div>
                        </div>
                    </div>
                    <button class="btn-secondary remove-choice-btn" style="width: auto; padding: 0.6rem 0.9rem; border-color: rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: var(--border-radius-md);" title="Remove from list">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `;
            
            card.querySelector(".remove-choice-btn").addEventListener("click", async (e) => {
                e.stopPropagation();
                await removeChoiceItem({
                    code: c.code,
                    branch: c.branch,
                    name: c.name
                });
            });
            
            container.appendChild(card);
        });
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Error loading choices.</div>';
    }
}

async function removeChoiceItem(data) {
    try {
        const response = await fetch(`${API_URL}/choice/remove?session_id=${sessionId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const resData = await response.json();
        document.getElementById("choice-count").textContent = resData.count;
        showToast(`Removed ${data.name} from Choice List!`, "success");
        loadChoices(); // Reload choices view
    } catch (error) {
        showToast("Failed to remove college from Choice List.", "error");
    }
}

async function loadTFC() {
    const container = document.getElementById("tfc-container");

    // If already loaded in memory, render it immediately
    if (tfcCenters.length > 0) {
        renderTFC(tfcCenters);
        return;
    }

    container.innerHTML = '<div class="empty-state">Fetching TFC locations...</div>';

    try {
        const response = await fetch(`${API_URL}/tfc`);
        tfcCenters = await response.json();
        renderTFC(tfcCenters);
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Error loading TFC centers.</div>';
    }
}

function renderTFC(tfcs) {
    const container = document.getElementById("tfc-container");
    container.innerHTML = "";
    
    if (tfcs.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; max-width: 100%;">
                No TFC Centers found matching your criteria.
            </div>
        `;
        return;
    }
    
    // Parse a raw contact string from DB. Format is "Name\nRole\nPhone" (newline-delimited)
    // Example: "Dr K Lakshmi\nPrincipal\n9486229115"
    const parseContact = (text) => {
        if (!text) return null;
        
        // Split by newline — DB stores as: line1=name, line2=role, line3=phone
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let name = '';
        let role = '';
        let phone = null;
        
        for (const line of lines) {
            if (/^\d{10}$/.test(line)) {
                // Pure 10-digit phone number
                phone = line;
            } else if (!phone && /\d{10}/.test(line)) {
                // Line contains a 10-digit phone mixed with text
                phone = line.match(/\d{10}/)[0];
                const remaining = line.replace(/\d{10}/, '').trim();
                if (remaining && !name) name = remaining;
                else if (remaining && !role) role = remaining;
            } else if (!name) {
                name = line;
            } else if (!role) {
                role = line;
            }
        }
        
        if (!name) name = 'Contact Person';
        
        return { name, role, phone };
    };

    tfcs.forEach((t, index) => {
        const card = document.createElement("div");
        card.className = "tfc-card";
        
        const person1 = parseContact(t.coordinator);
        const person2 = parseContact(t.contact);
        
        // Clean newlines from address for display and maps
        const displayAddress = (t.name_address || '').replace(/\n/g, ', ').replace(/,\s*,/g, ',').trim();
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(displayAddress)}`;
        
        // Build contact rows
        const buildContactRow = (person, label, iconClass, colorClass) => {
            if (!person) return '';
            return `
                <div class="tfc-contact-row">
                    <div class="tfc-contact-avatar ${colorClass}">
                        <i class="fas ${iconClass}"></i>
                    </div>
                    <div class="tfc-contact-info">
                        <span class="tfc-contact-label">${label}</span>
                        <span class="tfc-contact-name">${person.name}</span>
                        ${person.role ? `<span class="tfc-contact-role">${person.role}</span>` : ''}
                    </div>
                    ${person.phone ? `
                        <a href="tel:${person.phone}" class="tfc-call-btn" title="Call ${person.name}">
                            <i class="fas fa-phone-alt"></i>
                            <span>${person.phone}</span>
                        </a>
                    ` : `<span class="tfc-no-phone">No phone</span>`}
                </div>
            `;
        };
        
        card.innerHTML = `
            <div class="tfc-card-accent"></div>
            <div class="tfc-card-header">
                <div class="tfc-icon-wrapper">
                    <i class="fas fa-building"></i>
                </div>
                <span class="tfc-badge">TFC Center #${t.tfc_number || index + 1}</span>
            </div>
            
            <div class="tfc-card-body">
                <h4 class="tfc-title">${displayAddress}</h4>
                
                <div class="tfc-info-row">
                    <i class="fas fa-map-marker-alt tfc-info-icon location"></i>
                    <div class="tfc-info-text">
                        <span class="tfc-info-label">District</span>
                        <span class="tfc-info-value">${t.district}</span>
                    </div>
                </div>
                
                <div class="tfc-contacts-section">
                    <span class="tfc-contacts-heading"><i class="fas fa-address-book"></i> Contacts</span>
                    ${buildContactRow(person1, 'Coordinator', 'fa-user-tie', 'coord')}
                    ${buildContactRow(person2, 'Assistant', 'fa-user-shield', 'assist')}
                </div>
            </div>
            
            <div class="tfc-card-footer">
                <div class="tfc-actions-grid">
                    <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="tfc-action-btn secondary-btn">
                        <i class="fas fa-directions"></i> Directions
                    </a>
                    <button class="tfc-action-btn primary-btn details-trigger-btn">
                        View Details <i class="fas fa-arrow-right"></i>
                    </button>
                </div>
            </div>
        `;
        
        // Add event listeners to detail buttons
        card.querySelectorAll(".details-trigger-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                showTfcDetailsModal(t);
            });
        });
        
        container.appendChild(card);
    });
}

function showTfcDetailsModal(tfc) {
    const modalOverlay = document.createElement("div");
    modalOverlay.className = "tfc-modal-overlay";
    
    // Reuse the same parser — DB format is "Name\nRole\nPhone"
    const parseContact = (text) => {
        if (!text) return null;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let name = '', role = '', phone = null;
        for (const line of lines) {
            if (/^\d{10}$/.test(line)) {
                phone = line;
            } else if (!phone && /\d{10}/.test(line)) {
                phone = line.match(/\d{10}/)[0];
                const remaining = line.replace(/\d{10}/, '').trim();
                if (remaining && !name) name = remaining;
                else if (remaining && !role) role = remaining;
            } else if (!name) {
                name = line;
            } else if (!role) {
                role = line;
            }
        }
        if (!name) name = 'Contact Person';
        return { name, role, phone };
    };
    
    const person1 = parseContact(tfc.coordinator);
    const person2 = parseContact(tfc.contact);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(tfc.name_address)}`;
    
    const buildModalContact = (person, label) => {
        if (!person) return '';
        return `
            <div class="tfc-modal-contact-card">
                <div class="tfc-modal-contact-header">
                    <span class="tfc-detail-label">${label}</span>
                </div>
                <div class="tfc-modal-contact-body">
                    <div>
                        <p class="tfc-modal-contact-name">${person.name}</p>
                        ${person.role ? `<p class="tfc-modal-contact-role">${person.role}</p>` : ''}
                    </div>
                    ${person.phone ? `
                        <a href="tel:${person.phone}" class="tfc-modal-call-btn">
                            <i class="fas fa-phone-alt"></i>
                            ${person.phone}
                        </a>
                    ` : '<span class="tfc-no-phone">Not available</span>'}
                </div>
            </div>
        `;
    };
    
    modalOverlay.innerHTML = `
        <div class="tfc-modal-content">
            <button class="tfc-modal-close"><i class="fas fa-times"></i></button>
            
            <div class="tfc-modal-header">
                <div class="tfc-modal-icon-wrapper">
                    <i class="fas fa-building"></i>
                </div>
                <div>
                    <div class="tfc-modal-badge">TFC Center #${tfc.tfc_number}</div>
                    <h3 class="tfc-modal-title">${tfc.district} District Center</h3>
                </div>
            </div>
            
            <div class="tfc-modal-body">
                <div class="tfc-detail-section">
                    <span class="tfc-detail-label"><i class="fas fa-building"></i> Institution & Address</span>
                    <p class="tfc-detail-value address-text">${tfc.name_address}</p>
                </div>
                
                <div class="tfc-modal-contacts-wrapper">
                    ${buildModalContact(person1, '<i class="fas fa-user-tie"></i> Coordinator')}
                    ${buildModalContact(person2, '<i class="fas fa-user-shield"></i> Assistant Contact')}
                </div>
                
                <div class="tfc-modal-info-alert">
                    <i class="fas fa-info-circle"></i>
                    <p>You can visit this center for official certificate verification and help with option filling during your designated rounds.</p>
                </div>
            </div>
            
            <div class="tfc-modal-footer">
                <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="tfc-modal-btn secondary">
                    <i class="fas fa-directions"></i> Open Google Maps
                </a>
                <button class="tfc-modal-btn primary close-btn">
                    Close Panel
                </button>
            </div>
        </div>
    `;
    
    // Close events
    const closeModal = () => {
        modalOverlay.style.animation = "modalFadeOut 0.22s ease forwards";
        modalOverlay.querySelector(".tfc-modal-content").style.animation = "modalScaleOut 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards";
        modalOverlay.addEventListener("animationend", () => {
            modalOverlay.remove();
        });
    };
    
    modalOverlay.querySelector(".tfc-modal-close").addEventListener("click", closeModal);
    modalOverlay.querySelector(".close-btn").addEventListener("click", closeModal);
    
    // Close on overlay click
    modalOverlay.addEventListener("click", (e) => {
        if (e.target === modalOverlay) closeModal();
    });
    
    document.body.appendChild(modalOverlay);
}

function appendMessage(role, content) {
    const container = document.getElementById("chat-container");
    const rowDiv = document.createElement("div");
    rowDiv.className = `chat-message-row ${role}`;
    
    let avatarHtml = "";
    if (role === "bot") {
        avatarHtml = `<div class="chat-avatar bot-avatar"><i class="fas fa-robot"></i></div>`;
    } else {
        avatarHtml = `<div class="chat-avatar user-avatar"><i class="fas fa-user"></i></div>`;
    }
    
    const msgDiv = document.createElement("div");
    msgDiv.className = `chat-message ${role}`;
    msgDiv.innerHTML = `<div class="message-content">${content}</div>`;
    
    if (role === "bot") {
        rowDiv.innerHTML = avatarHtml;
        rowDiv.appendChild(msgDiv);
    } else {
        rowDiv.appendChild(msgDiv);
        rowDiv.innerHTML += avatarHtml;
    }
    
    container.appendChild(rowDiv);
    container.scrollTop = container.scrollHeight;
}

function appendLoadingMessage() {
    const id = "loading-" + Date.now();
    const container = document.getElementById("chat-container");
    const rowDiv = document.createElement("div");
    rowDiv.className = "chat-message-row bot";
    rowDiv.id = id;
    
    const avatarHtml = `<div class="chat-avatar bot-avatar"><i class="fas fa-robot"></i></div>`;
    
    const msgDiv = document.createElement("div");
    msgDiv.className = "chat-message bot";
    msgDiv.innerHTML = `
        <div class="message-content">
            <div class="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;
    
    rowDiv.innerHTML = avatarHtml;
    rowDiv.appendChild(msgDiv);
    container.appendChild(rowDiv);
    container.scrollTop = container.scrollHeight;
    return id;
}

function removeLoadingMessage(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function showLoader(show) {
    document.getElementById("loading-overlay").classList.toggle("hidden", !show);
}

function updateSidebarInfo() {
    const cutoff = document.getElementById("input-cutoff").value;
    const category = document.getElementById("input-category").value;
    const cutoffEl = document.getElementById("session-cutoff");
    const categoryEl = document.getElementById("session-category");
    
    if (cutoffEl) cutoffEl.textContent = cutoff || "---";
    if (categoryEl) categoryEl.textContent = category || "---";
}

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// -------------------------------------------------------------
// Toast Notification System
// -------------------------------------------------------------
function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    let icon = "fa-info-circle";
    let title = "System Notification";
    if (type === "success") {
        icon = "fa-check-circle";
        title = "Successful Action";
    } else if (type === "error") {
        icon = "fa-exclamation-circle";
        title = "System Error";
    }
    
    toast.innerHTML = `
        <div class="toast-icon"><i class="fas ${icon}"></i></div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close"><i class="fas fa-times"></i></button>
    `;
    
    // Close button event
    toast.querySelector(".toast-close").addEventListener("click", () => {
        removeToast(toast);
    });
    
    container.appendChild(toast);
    
    // Auto remove
    setTimeout(() => {
        removeToast(toast);
    }, 4500);
}

function removeToast(toast) {
    if (!toast.parentNode) return;
    toast.style.animation = "toastOut 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards";
    toast.addEventListener("animationend", () => {
        toast.remove();
    });
}
