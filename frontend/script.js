const API_URL = "";
let sessionId = uuidv4();
let currentTab = "chat";
let previousTab = "chat";
let currentTier = "safe";
let allRecommendations = [];
let directoryColleges = [];
let currentDirectoryPage = 1;
let tfcCenters = [];
let directoryDebounceTimeout = null;
let directoryAbortController = null;   // cancels stale in-flight requests
let directoryLoadPending = false;       // debounce lock to stop burst calls

// Initialize
document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    setupEventListeners();
    updateSidebarInfo();
    loadMetadata(); // Dynamically load districts and branches into multi-select dropdowns
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

    // PDF / CSV / TXT Print & Choice List Export Options
    const downloadBtn = document.getElementById("download-options-btn");
    const downloadContainer = document.querySelector(".download-dropdown-container");
    if (downloadBtn && downloadContainer) {
        downloadBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            downloadContainer.classList.toggle("active");
        });
        
        // Close when clicking outside
        document.addEventListener("click", () => {
            downloadContainer.classList.remove("active");
        });
    }

    // Export formats handlers
    document.querySelectorAll(".download-opt").forEach(opt => {
        opt.addEventListener("click", async (e) => {
            e.stopPropagation();
            downloadContainer?.classList.remove("active");
            
            const format = opt.dataset.format;
            try {
                const response = await fetch(`${API_URL}/choice/${sessionId}`);
                const choices = await response.json();
                
                if (choices.length === 0) {
                    showToast("Your choice list is empty. Add choices first!", "warning");
                    return;
                }
                
                if (format === "csv") {
                    downloadChoiceListAsCSV(choices);
                    showToast("Choice List successfully downloaded as CSV!", "success");
                } else if (format === "txt") {
                    downloadChoiceListAsTXT(choices);
                    showToast("Choice List successfully downloaded as Text File!", "success");
                } else if (format === "pdf") {
                    window.print();
                }
            } catch (error) {
                showToast("Failed to export choice list.", "error");
            }
        });
    });

    // Clear Choices List button
    const clearChoicesBtn = document.getElementById("clear-choices-btn");
    if (clearChoicesBtn) {
        clearChoicesBtn.addEventListener("click", async () => {
            if (confirm("Are you sure you want to clear your entire Choice List? This cannot be undone.")) {
                try {
                    const response = await fetch(`${API_URL}/choice/clear?session_id=${sessionId}`, {
                        method: "POST"
                    });
                    if (response.ok) {
                        document.getElementById("choice-count").textContent = 0;
                        showToast("Choice List cleared successfully!", "success");
                        loadChoices();
                    }
                } catch (error) {
                    showToast("Failed to clear Choice List.", "error");
                }
            }
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

    // Directory Pagination button handlers
    const dirPrevBtn = document.getElementById("dir-prev-btn");
    const dirNextBtn = document.getElementById("dir-next-btn");
    if (dirPrevBtn && dirNextBtn) {
        dirPrevBtn.addEventListener("click", () => {
            if (currentDirectoryPage > 1) {
                currentDirectoryPage--;
                const searchVal = document.getElementById("directory-search")?.value.trim() || "";
                loadDirectory(searchVal, true);
                
                // Smooth scroll back to top of the directory grid
                document.getElementById("directory-view")?.scrollIntoView({ behavior: "smooth" });
            }
        });
        dirNextBtn.addEventListener("click", () => {
            currentDirectoryPage++;
            const searchVal = document.getElementById("directory-search")?.value.trim() || "";
            loadDirectory(searchVal, true);
            
            // Smooth scroll back to top of the directory grid
            document.getElementById("directory-view")?.scrollIntoView({ behavior: "smooth" });
        });
    }

    // -----------------------------------------------------------------
    // Cutoff Calculator Event Handlers
    // -----------------------------------------------------------------
    let calculatedCutoffGlobal = 0.0;
    let selectedCategoryGlobal = "OC";
    let selectedDistrictGlobal = "All";
    let selectedBranchGlobal = "All";

    const calcForm = document.getElementById("cutoff-calc-form");
    if (calcForm) {
        calcForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            
            const maths = parseFloat(document.getElementById("calc-maths").value) || 0.0;
            const physics = parseFloat(document.getElementById("calc-physics").value) || 0.0;
            const chemistry = parseFloat(document.getElementById("calc-chemistry").value) || 0.0;
            const category = document.getElementById("calc-category").value;
            const district = document.getElementById("calc-district").value;
            const branch = document.getElementById("calc-branch").value;
            
            if (maths < 0 || maths > 100 || physics < 0 || physics > 100 || chemistry < 0 || chemistry > 100) {
                showToast("Subject marks must be between 0 and 100.", "warning");
                return;
            }
            
            showLoader(true);
            
            try {
                const response = await fetch(`${API_URL}/calculate-cutoff`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        maths: maths,
                        physics: physics,
                        chemistry: chemistry,
                        category: category,
                        district: district,
                        preferred_branch: branch
                    })
                });
                
                if (!response.ok) throw new Error("Calculator API failed");
                const res = await response.json();
                
                calculatedCutoffGlobal = res.cutoff;
                selectedCategoryGlobal = category;
                selectedDistrictGlobal = district;
                selectedBranchGlobal = branch;
                
                // Render result value
                document.getElementById("calc-result-value").textContent = res.cutoff.toFixed(2);
                
                // Render tier badge
                const tierEl = document.getElementById("calc-result-tier");
                tierEl.textContent = res.eligibility_tier;
                tierEl.className = "probability-badge"; // Reset styles
                const tLower = res.eligibility_tier.toLowerCase();
                if (tLower.includes("safe")) {
                    tierEl.classList.add("safe");
                } else if (tLower.includes("moderate")) {
                    tierEl.classList.add("moderate");
                } else {
                    tierEl.classList.add("dream");
                }
                
                // Render advisor summary
                const formattedSummary = res.recommendation_summary.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                document.getElementById("calc-recommendation-summary").innerHTML = formattedSummary;
                
                // Render dynamic suitability branch badges
                const branchesGrid = document.getElementById("calc-suggested-branches");
                branchesGrid.innerHTML = "";
                res.suggested_branches.forEach(b => {
                    const pill = document.createElement("span");
                    pill.className = "accredited-tag yes";
                    pill.style.padding = "0.4rem 0.75rem";
                    pill.style.fontSize = "0.76rem";
                    pill.style.cursor = "pointer";
                    pill.style.display = "inline-flex";
                    pill.style.alignItems = "center";
                    pill.style.gap = "0.3rem";
                    pill.innerHTML = `<i class="fas fa-check-circle"></i> ${b}`;
                    
                    pill.addEventListener("click", () => {
                        const branchSelect = document.getElementById("calc-branch");
                        let found = false;
                        for (let i = 0; i < branchSelect.options.length; i++) {
                            if (branchSelect.options[i].value.toLowerCase().includes(b.toLowerCase()) || 
                                b.toLowerCase().includes(branchSelect.options[i].value.toLowerCase())) {
                                branchSelect.selectedIndex = i;
                                found = true;
                                break;
                            }
                        }
                        if (found) {
                            // trigger form submit to recalculate
                            calcForm.dispatchEvent(new Event("submit"));
                            showToast(`Recalculating predictions for suitability branch: ${b}`, "success");
                        }
                    });
                    
                    branchesGrid.appendChild(pill);
                });
                
                // Reveal the result panel
                document.getElementById("calc-result-panel").classList.remove("hidden");
                showToast("Cutoff and Expected Range computed successfully!", "success");
                
            } catch (err) {
                console.error(err);
                showToast("Failed to calculate cutoff values.", "error");
            } finally {
                showLoader(false);
            }
        });
    }

    // CTA Redirections
    const actionFindBtn = document.getElementById("calc-action-find");
    if (actionFindBtn) {
        actionFindBtn.addEventListener("click", () => {
            if (calculatedCutoffGlobal === 0) return;
            
            // 1. Pre-fill Finder Cutoff and Category
            document.getElementById("input-cutoff").value = calculatedCutoffGlobal.toFixed(2);
            document.getElementById("input-category").value = selectedCategoryGlobal;
            
            // 2. Select pre-selected district in multi-select trigger
            if (selectedDistrictGlobal && selectedDistrictGlobal !== "All") {
                selectMultiSelectOption("finder-district-select", selectedDistrictGlobal);
            } else {
                selectMultiSelectOption("finder-district-select", null); // clear
            }
            
            // 3. Select pre-selected branch in multi-select trigger
            if (selectedBranchGlobal && selectedBranchGlobal !== "All") {
                selectMultiSelectOption("finder-branch-select", selectedBranchGlobal);
            } else {
                selectMultiSelectOption("finder-branch-select", null); // clear
            }
            
            // 4. Switch tab to finder
            const finderNavBtn = document.querySelector('.nav-item[data-tab="finder"]');
            if (finderNavBtn) {
                document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
                finderNavBtn.classList.add("active");
            }
            switchTab("finder");
            
            // 5. Trigger Recommendations search!
            findColleges();
            showToast(`Finder populated with Cutoff ${calculatedCutoffGlobal.toFixed(2)} and category ${selectedCategoryGlobal}!`, "success");
        });
    }

    const actionTrendsBtn = document.getElementById("calc-action-trends");
    if (actionTrendsBtn) {
        actionTrendsBtn.addEventListener("click", () => {
            // Batch all multiselect changes WITHOUT triggering loadDirectory yet
            // Use the silent variant so no change events fire during setup
            if (selectedDistrictGlobal && selectedDistrictGlobal !== "All") {
                selectMultiSelectOptionSilent("directory-district-select", selectedDistrictGlobal);
            } else {
                selectMultiSelectOptionSilent("directory-district-select", null);
            }
            
            if (selectedBranchGlobal && selectedBranchGlobal !== "All") {
                selectMultiSelectOptionSilent("directory-branch-select", selectedBranchGlobal);
            } else {
                selectMultiSelectOptionSilent("directory-branch-select", null);
            }

            // Update the labels after silent batch changes
            updateMultiSelectLabel("directory-district-select");
            updateMultiSelectLabel("directory-branch-select");
            
            // Switch tab to directory — this will trigger ONE loadDirectory() call
            const dirNavBtn = document.querySelector('.nav-item[data-tab="directory"]');
            if (dirNavBtn) {
                document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
                dirNavBtn.classList.add("active");
            }
            switchTab("directory");
            showToast("Directory loaded with your calculator preferences!", "success");
        });
    }

    const actionChatBtn = document.getElementById("calc-action-chat");
    if (actionChatBtn) {
        actionChatBtn.addEventListener("click", () => {
            if (calculatedCutoffGlobal === 0) return;
            
            const promptText = `I calculated a TNEA cutoff of ${calculatedCutoffGlobal.toFixed(2)} under category ${selectedCategoryGlobal}. My preferred district is ${selectedDistrictGlobal} and my preferred branch is ${selectedBranchGlobal}. Suggest top colleges and a counselling strategy.`;
            
            // Switch tab to Counselling Expert
            const chatNavBtn = document.querySelector('.nav-item[data-tab="chat"]');
            if (chatNavBtn) {
                document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
                chatNavBtn.classList.add("active");
            }
            switchTab("chat");
            
            const chatInput = document.getElementById("chat-input");
            if (chatInput) {
                chatInput.value = promptText;
                sendMessage();
            }
        });
    }
}

function switchTab(tabId) {
    if (currentTab !== "profile") previousTab = currentTab;
    currentTab = tabId;
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById(`${tabId}-view`).classList.add("active");
    
    if (tabId === "directory") {
        // Don't wipe search here — caller (cutoff trends) may have set filters
        // Only clear the text search when navigating via sidebar (not from calculator)
        const searchInput = document.getElementById("directory-search");
        const searchVal = searchInput ? searchInput.value.trim() : "";
        // Reset page to 1 on any tab switch to directory
        currentDirectoryPage = 1;
        loadDirectory(searchVal);
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
    const districts = getSelectedMultiSelectValues("finder-district-select");
    const branches = getSelectedMultiSelectValues("finder-branch-select");

    showLoader(true);
    updateSidebarInfo();

    try {
        const response = await fetch(`${API_URL}/recommend`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cutoff,
                category,
                districts,
                branches,
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
                district: rec.district || "Unknown",
                tier: rec.tier || "Moderate",
                cutoff: rec.cutoff || "N/A"
            });
        });
        
        container.appendChild(card);
    });
}

async function loadDirectory(searchQuery = "", isPaginationAction = false) {
    // --- Debounce / burst guard: if a load is already queued, skip this call ---
    if (directoryLoadPending) return;
    directoryLoadPending = true;
    // Release the lock after a short delay so rapid bursts get collapsed
    setTimeout(() => { directoryLoadPending = false; }, 80);

    // Abort any in-flight request from a previous call
    if (directoryAbortController) {
        directoryAbortController.abort();
    }
    directoryAbortController = new AbortController();
    const signal = directoryAbortController.signal;

    const container = document.getElementById("directory-container");

    const districts = getSelectedMultiSelectValues("directory-district-select");
    const branches = getSelectedMultiSelectValues("directory-branch-select");
    const hasFilters = searchQuery || (districts && districts.length > 0) || (branches && branches.length > 0);

    if (!isPaginationAction) {
        currentDirectoryPage = 1;
    }

    // Show skeleton only when there's no cached data or filters changed
    if (directoryColleges.length === 0 || hasFilters || isPaginationAction) {
        container.innerHTML = '<div class="empty-state">Fetching historical trends...</div>';
    }

    try {
        let url = `${API_URL}/directory?`;
        const params = [];
        if (searchQuery) {
            params.push(`search=${encodeURIComponent(searchQuery)}`);
        }
        if (districts && districts.length > 0) {
            districts.forEach(d => params.push(`districts=${encodeURIComponent(d)}`));
        }
        if (branches && branches.length > 0) {
            branches.forEach(b => params.push(`branches=${encodeURIComponent(b)}`));
        }
        params.push(`page=${currentDirectoryPage}`);
        params.push(`limit=50`);
        url += params.join("&");

        const response = await fetch(url, { signal });
        const data = await response.json();
        
        const colleges = data.colleges || (Array.isArray(data) ? data : []);
        const total = data.total !== undefined ? data.total : colleges.length;
        const pages = data.pages !== undefined ? data.pages : 1;
        
        if (!hasFilters && currentDirectoryPage === 1) {
            directoryColleges = colleges;
        }
        
        renderDirectory(colleges);
        renderDirectoryPagination(total, pages);
    } catch (error) {
        if (error.name === "AbortError") return; // silently ignore cancelled requests
        container.innerHTML = '<div class="empty-state">Error loading directory.</div>';
        const paginationEl = document.getElementById("directory-pagination");
        if (paginationEl) paginationEl.style.display = "none";
    }
}

function renderDirectoryPagination(total, pages) {
    const paginationEl = document.getElementById("directory-pagination");
    const prevBtn = document.getElementById("dir-prev-btn");
    const nextBtn = document.getElementById("dir-next-btn");
    const infoEl = document.getElementById("dir-page-info");
    
    if (!paginationEl || !prevBtn || !nextBtn || !infoEl) return;
    
    if (total === 0 || pages <= 1) {
        paginationEl.style.display = "none";
        return;
    }
    
    paginationEl.style.display = "flex";
    infoEl.textContent = `Page ${currentDirectoryPage} of ${pages} (${total} colleges)`;
    
    prevBtn.disabled = (currentDirectoryPage <= 1);
    nextBtn.disabled = (currentDirectoryPage >= pages);
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
        document.getElementById("profile-subtitle").textContent = `Code: ${data.code || code} | ${data.district || 'Tamil Nadu'}`;
        
        const content = document.getElementById("profile-content");
        content.innerHTML = "";

        const contact = data.contact || {};
        const hostel = data.hostel || {};
        const transport = data.transport || {};
        const courses = data.courses || [];
        const branches = data.branches || {};

        // Injected Cyber-dashboard
        content.innerHTML = `
            <!-- Top Banner Card & Actions -->
            <div class="college-profile-top-banner">
                <div class="banner-badge-row">
                    ${data.autonomous_status 
                        ? '<span class="status-badge autonomous-badge"><i class="fas fa-certificate"></i> Autonomous</span>' 
                        : '<span class="status-badge non-autonomous-badge"><i class="fas fa-university"></i> Non-Autonomous</span>'
                    }
                    ${data.minority_status 
                        ? '<span class="status-badge minority-badge"><i class="fas fa-shield-alt"></i> Minority Quota</span>' 
                        : ''
                    }
                    <span class="status-badge confidence-badge"><i class="fas fa-check-double"></i> Data Trust: ${(data.parse_confidence * 100).toFixed(0)}%</span>
                </div>
                
                <div class="banner-action-buttons">
                    ${contact.phone ? `<a href="tel:${contact.phone}" class="profile-action-btn phone-btn"><i class="fas fa-phone-alt"></i> Call Admissions</a>` : ''}
                    ${contact.anti_ragging_phone ? `<a href="tel:${contact.anti_ragging_phone}" class="profile-action-btn anti-ragging-btn"><i class="fas fa-shield-virus"></i> Anti-Ragging Helpline</a>` : ''}
                    ${contact.email ? `<a href="mailto:${contact.email}" class="profile-action-btn email-btn"><i class="fas fa-envelope"></i> Email College</a>` : ''}
                    ${contact.website ? `<a href="${contact.website}" target="_blank" rel="noopener noreferrer" class="profile-action-btn website-btn"><i class="fas fa-external-link-alt"></i> Official Website <i class="fas fa-arrow-right" style="font-size:0.75rem;"></i></a>` : ''}
                </div>
            </div>

            <!-- Cybernetic 5-Tab Bar -->
            <div class="profile-navigation-tabs">
                <button class="profile-nav-tab active" data-profile-tab="overview"><i class="fas fa-info-circle"></i> Overview</button>
                <button class="profile-nav-tab" data-profile-tab="courses"><i class="fas fa-graduation-cap"></i> Courses offered (${courses.length})</button>
                <button class="profile-nav-tab" data-profile-tab="hostel"><i class="fas fa-home"></i> Hostel Details</button>
                <button class="profile-nav-tab" data-profile-tab="transport"><i class="fas fa-bus"></i> Transport</button>
                <button class="profile-nav-tab" data-profile-tab="cutoffs"><i class="fas fa-chart-line"></i> Cutoff Trends</button>
            </div>

            <!-- Tab Panels container -->
            <div class="profile-tab-panels">
                
                <!-- 1. Overview Panel -->
                <div class="profile-tab-panel active" id="panel-overview">
                    <div class="profile-grid">
                        <div class="info-card">
                            <div class="info-card-header"><i class="fas fa-user-tie"></i> Administration</div>
                            <div class="info-card-body">
                                <h3 style="color:var(--text-primary); font-size:1.3rem;">${data.principal_name || 'Not Available'}</h3>
                                <p class="role-subtitle">Principal / Head of Institution</p>
                            </div>
                        </div>

                        <div class="info-card">
                            <div class="info-card-header"><i class="fas fa-map-marked-alt"></i> Location & Address Details</div>
                            <div class="info-card-body">
                                <p style="font-size:0.9rem; line-height:1.5; color:var(--text-primary);"><strong>Full Address:</strong> ${data.address || 'Not Available'}</p>
                                <div class="location-sub-grid">
                                    <div><span>Taluk</span><b>${data.taluk || 'N/A'}</b></div>
                                    <div><span>District</span><b>${data.district || 'N/A'}</b></div>
                                    <div><span>Pincode</span><b>${data.pincode || 'N/A'}</b></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 2. Courses Panel -->
                <div class="profile-tab-panel" id="panel-courses">
                    <div class="table-container">
                        <table class="futuristic-table">
                            <thead>
                                <tr>
                                    <th>Code</th>
                                    <th>Branch/Course Name</th>
                                    <th>Approved Intake</th>
                                    <th>Started</th>
                                    <th>Accreditation Status (NBA)</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${courses.length > 0 ? courses.map(c => `
                                    <tr>
                                        <td class="table-highlight"><b>${c.branch_code}</b></td>
                                        <td><b>${c.branch_name}</b></td>
                                        <td><span class="badge-intake">${c.approved_intake || '-'}</span></td>
                                        <td>${c.year_started || '-'}</td>
                                        <td>
                                            ${c.accredited 
                                                ? `<span class="accredited-tag yes"><i class="fas fa-check-circle"></i> NBA Accredited (Upto ${c.accredited_valid_upto})</span>` 
                                                : `<span class="accredited-tag no"><i class="fas fa-times-circle"></i> Non-Accredited</span>`
                                            }
                                        </td>
                                        <td>
                                            <button class="btn-secondary add-course-choice-btn" 
                                                    style="padding: 0.45rem 0.8rem; font-size: 0.72rem; border-radius: var(--border-radius-sm); border-color: rgba(16, 185, 129, 0.4); color: #10b981; font-weight: 600; display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer; transition: all 0.2s;"
                                                    data-code="${data.college_code}" 
                                                    data-name="${data.college_name}" 
                                                    data-branch="${c.branch_name}" 
                                                    data-district="${data.district || 'Tamil Nadu'}">
                                                <i class="fas fa-bookmark"></i> Bookmark
                                            </button>
                                        </td>
                                    </tr>
                                `).join("") : '<tr><td colspan="6" style="text-align: center; padding: 2rem;">No course records available in SQL database.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- 3. Hostel Panel -->
                <div class="profile-tab-panel" id="panel-hostel">
                    <div class="profile-grid">
                        <div class="info-card">
                            <div class="info-card-header boys-header"><i class="fas fa-male"></i> Boys Hostel</div>
                            <div class="info-card-body text-center">
                                ${hostel.boys_hostel_available 
                                    ? `<span class="avail-badge yes"><i class="fas fa-check"></i> Accommodation Available</span>`
                                    : `<span class="avail-badge no"><i class="fas fa-times"></i> Accommodation Not Available</span>`
                                }
                            </div>
                        </div>

                        <div class="info-card">
                            <div class="info-card-header girls-header"><i class="fas fa-female"></i> Girls Hostel</div>
                            <div class="info-card-body text-center">
                                ${hostel.girls_hostel_available 
                                    ? `<span class="avail-badge yes"><i class="fas fa-check"></i> Accommodation Available</span>`
                                    : `<span class="avail-badge no"><i class="fas fa-times"></i> Accommodation Not Available</span>`
                                }
                            </div>
                        </div>
                    </div>

                    <div class="info-card fee-breakdown-card" style="margin-top: 1.5rem;">
                        <div class="info-card-header"><i class="fas fa-calculator"></i> Fee Structure Breakdown</div>
                        <div class="info-card-body">
                            <div class="fee-grid">
                                <div class="fee-item"><span>Mess Bill:</span> <b>₹${hostel.mess_bill ? hostel.mess_bill.toLocaleString() : '0'}/month</b></div>
                                <div class="fee-item"><span>Room Rent:</span> <b>₹${hostel.room_rent ? hostel.room_rent.toLocaleString() : '0'}/year</b></div>
                                <div class="fee-item"><span>Electricity Charges:</span> <b>₹${hostel.electricity_charges ? hostel.electricity_charges.toLocaleString() : '0'}/year</b></div>
                                <div class="fee-item"><span>Caution Deposit:</span> <b>₹${hostel.caution_deposit ? hostel.caution_deposit.toLocaleString() : '0'} (Refundable)</b></div>
                                <div class="fee-item highlighted"><span>Establishment Charges:</span> <b>₹${hostel.establishment_charges ? hostel.establishment_charges.toLocaleString() : '0'}/year</b></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 4. Transport Panel -->
                <div class="profile-tab-panel" id="panel-transport">
                    <div class="profile-grid">
                        <div class="info-card">
                            <div class="info-card-header"><i class="fas fa-bus"></i> Transport Availability</div>
                            <div class="info-card-body text-center" style="padding: 2.2rem 1.6rem;">
                                ${transport.facilities_available 
                                    ? `<div>
                                           <span class="avail-badge yes" style="font-size:1.1rem; padding:0.6rem 1.4rem;"><i class="fas fa-check"></i> Bus Service Available</span>
                                           <p style="margin-top: 1.25rem; font-size: 0.88rem; line-height: 1.5; color: var(--text-secondary);">Charges range from <b>₹${transport.min_transport_charges ? transport.min_transport_charges.toLocaleString() : '0'}</b> to <b>₹${transport.max_transport_charges ? transport.max_transport_charges.toLocaleString() : '0'}</b> per year depending on boarding point distance.</p>
                                       </div>`
                                    : `<span class="avail-badge no" style="font-size:1.1rem; padding:0.6rem 1.4rem;"><i class="fas fa-times"></i> Bus Service Not Available</span>`
                                }
                            </div>
                        </div>

                        <div class="info-card">
                            <div class="info-card-header"><i class="fas fa-train"></i> Nearest Railway Logistics</div>
                            <div class="info-card-body">
                                <div class="train-info-block">
                                    <div class="train-station-icon"><i class="fas fa-subway"></i></div>
                                    <div style="flex:1;">
                                        <span style="font-size:0.75rem; color:var(--text-muted); font-weight:700; text-transform:uppercase;">Railway Station</span>
                                        <h3 style="margin: 0.15rem 0 0.5rem 0; font-size: 1.15rem; color: var(--text-primary);">${transport.nearest_railway_station || 'Not Available'}</h3>
                                        <div class="distance-pill"><i class="fas fa-route"></i> Distance: <b>${transport.railway_distance_km ? transport.railway_distance_km + ' km' : 'N/A'}</b></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 5. Cutoff Trends Panel -->
                <div class="profile-tab-panel" id="panel-cutoffs">
                    <div class="cutoff-selectors-grid">
                        <div class="form-group">
                            <label>Branch / Specialization</label>
                            <select id="cutoff-branch-select" class="glossy-select"></select>
                        </div>
                        <div class="form-group">
                            <label>Community / Quota Category</label>
                            <select id="cutoff-community-select" class="glossy-select">
                                <option value="OC">OC (Open Competition)</option>
                                <option value="BC">BC (Backward Class)</option>
                                <option value="BCM">BCM (Backward Class Muslim)</option>
                                <option value="MBC">MBC (Most Backward Class)</option>
                                <option value="SC">SC (Scheduled Caste)</option>
                                <option value="SCA">SCA (SC Arundhathiyar)</option>
                                <option value="ST">ST (Scheduled Tribe)</option>
                            </select>
                        </div>
                    </div>

                    <div class="chart-container-card">
                        <div class="chart-header">
                            <h4><i class="fas fa-chart-area" style="color:var(--secondary-color);"></i> Y-o-Y Cutoff Trajectory Trend (2021-2025)</h4>
                            <span class="live-badge"><i class="fas fa-circle"></i> Connected SQL DB</span>
                        </div>
                        <div id="cutoff-chart-canvas" class="chart-canvas-area">
                            <!-- SVG Chart drawn dynamically in JavaScript -->
                        </div>
                        <div id="cutoff-table-area" style="margin-top:1.5rem;">
                            <!-- Data Grid table drawn dynamically -->
                        </div>
                    </div>

                    <!-- Admissions Strategist insights from Vector DB / RAG -->
                    ${data.historical_trends && data.historical_trends.length > 0 ? `
                        <div class="info-card strategist-notes-card" style="margin-top:1.5rem;">
                            <div class="info-card-header"><i class="fas fa-brain"></i> Admissions Strategist Insights (RAG Knowledge)</div>
                            <div class="info-card-body">
                                <div class="strategist-notes-scroll">
                                    ${data.historical_trends.map(t => `
                                        <div class="strategist-note-item">
                                            <span class="strategist-note-icon"><i class="fas fa-lightbulb"></i></span>
                                            <p>${t}</p>
                                        </div>
                                    `).join("")}
                                </div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        // ----------------------------------------------------
        // TAB PANEL SWITCHING EVENT HANDLERS
        // ----------------------------------------------------
        const tabs = content.querySelectorAll(".profile-nav-tab");
        const panels = content.querySelectorAll(".profile-tab-panel");

        tabs.forEach(tab => {
            tab.addEventListener("click", () => {
                tabs.forEach(t => t.classList.remove("active"));
                panels.forEach(p => p.classList.remove("active"));

                tab.classList.add("active");
                const activeTabId = tab.dataset.profileTab;
                content.querySelector(`#panel-${activeTabId}`).classList.add("active");
            });
        });

        // ----------------------------------------------------
        // DYNAMIC SVG CHART DRAWING & CORRESPONDING DATA GRID
        // ----------------------------------------------------
        const branchSelect = content.querySelector("#cutoff-branch-select");
        const communitySelect = content.querySelector("#cutoff-community-select");

        // Populate dynamic branch select options from cutoffs
        const branchNames = Object.keys(branches);
        if (branchNames.length > 0) {
            branchSelect.innerHTML = branchNames.map(b => `<option value="${b}">${b}</option>`).join("");
        } else {
            branchSelect.innerHTML = `<option value="">No Cutoff History Available</option>`;
        }

        const updateChart = () => {
            const selectedBranch = branchSelect.value;
            const selectedCommunity = communitySelect.value;
            const chartCanvas = content.querySelector("#cutoff-chart-canvas");
            const tableArea = content.querySelector("#cutoff-table-area");

            if (!selectedBranch || !branches[selectedBranch]) {
                chartCanvas.innerHTML = `<div class="empty-state">No cutoff history records found in SQLite for the selected course branch.</div>`;
                tableArea.innerHTML = "";
                return;
            }

            const history = branches[selectedBranch][selectedCommunity] || {};
            const years = ["2021", "2022", "2023", "2024", "2025"];
            const points = years.map(yr => ({ year: yr, val: history[yr] }));
            const validPoints = points.filter(p => p.val !== undefined && p.val !== null && p.val > 0);

            if (validPoints.length === 0) {
                chartCanvas.innerHTML = `<div class="empty-state" style="padding:2.5rem 1rem;">No historical cutoff records found in SQL for Quota category: <b>${selectedCommunity}</b>.</div>`;
                tableArea.innerHTML = "";
                return;
            }

            // Draw SVG Line Chart
            const width = 600;
            const height = 220;
            const padding = 40;

            const cutoffs = validPoints.map(p => p.val);
            const minCutoff = Math.max(0, Math.floor(Math.min(...cutoffs) - 5));
            const maxCutoff = Math.min(200, Math.ceil(Math.max(...cutoffs) + 5));
            const delta = maxCutoff - minCutoff || 10;

            const getX = (idx) => padding + (idx * (width - 2 * padding) / (years.length - 1));
            const getY = (val) => height - padding - ((val - minCutoff) * (height - 2 * padding) / delta);

            let gridLines = "";
            const numGridLines = 4;
            for (let i = 0; i <= numGridLines; i++) {
                const val = minCutoff + (i * delta / numGridLines);
                const y = getY(val);
                gridLines += `
                    <line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1" />
                    <text x="${padding - 10}" y="${y + 3}" fill="var(--text-muted)" font-size="9" font-family="monospace" text-anchor="end">${val.toFixed(1)}</text>
                `;
            }

            // Draw years labels
            years.forEach((yr, idx) => {
                const x = getX(idx);
                gridLines += `
                    <text x="${x}" y="${height - 15}" fill="var(--text-secondary)" font-size="10" font-weight="600" text-anchor="middle">${yr}</text>
                `;
            });

            let pathD = "";
            let dots = "";
            validPoints.forEach((p, idx) => {
                const yearIdx = years.indexOf(p.year);
                const x = getX(yearIdx);
                const y = getY(p.val);
                
                if (idx === 0) {
                    pathD = `M ${x} ${y}`;
                } else {
                    pathD += ` L ${x} ${y}`;
                }

                dots += `
                    <g class="chart-point-group">
                        <circle cx="${x}" cy="${y}" r="8" fill="var(--secondary)" opacity="0.1" />
                        <circle cx="${x}" cy="${y}" r="4.5" fill="var(--secondary)" stroke="white" stroke-width="1.5" />
                        <text x="${x}" y="${y - 12}" fill="var(--text-primary)" font-size="10" font-weight="700" text-anchor="middle" class="chart-val-label">${p.val.toFixed(2)}</text>
                    </g>
                `;
            });

            chartCanvas.innerHTML = `
                <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; overflow:visible;">
                    <defs>
                        <linearGradient id="cyber-grad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="var(--secondary)" stop-opacity="0.3"/>
                            <stop offset="100%" stop-color="var(--secondary)" stop-opacity="0.0"/>
                        </linearGradient>
                        <filter id="neon-stroke-glow">
                            <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
                            <feMerge>
                                <feMergeNode in="coloredBlur"/>
                                <feMergeNode in="SourceGraphic"/>
                            </feMerge>
                        </filter>
                    </defs>
                    
                    ${gridLines}
                    
                    <!-- Area mesh -->
                    ${validPoints.length > 1 ? `
                        <path d="${pathD} L ${getX(years.indexOf(validPoints[validPoints.length - 1].year))} ${height - padding} L ${getX(years.indexOf(validPoints[0].year))} ${height - padding} Z" fill="url(#cyber-grad)" />
                    ` : ''}

                    <!-- Neon trajectory curve -->
                    <path d="${pathD}" fill="none" stroke="var(--secondary)" stroke-width="2.5" filter="url(#neon-stroke-glow)" />
                    
                    <!-- Coordinate dots -->
                    ${dots}
                </svg>
            `;

            // Draw grid table
            tableArea.innerHTML = `
                <table class="futuristic-table mini-table">
                    <thead>
                        <tr>
                            ${years.map(y => `<th>${y} Cutoff</th>`).join("")}
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            ${years.map(y => {
                                const val = history[y];
                                return `<td><b style="color:${val ? 'var(--text-primary)' : 'var(--text-muted)'};">${val ? val.toFixed(2) : '-'}</b></td>`;
                            }).join("")}
                        </tr>
                    </tbody>
                </table>
            `;
        };

        // Attach Select selection triggers
        branchSelect.addEventListener("change", updateChart);
        communitySelect.addEventListener("change", updateChart);
        
        // Initial draw
        updateChart();

        // ----------------------------------------------------
        // COURSE BOOKMARKING EVENT HANDLERS
        // ----------------------------------------------------
        content.querySelectorAll(".add-course-choice-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const code = btn.dataset.code;
                const name = btn.dataset.name;
                const branch = btn.dataset.branch;
                const district = btn.dataset.district;
                
                // Calculate dynamic safety tier on the fly if cutoff & community is set
                const community = document.getElementById("select-community").value || 'OC';
                const userCutoff = parseFloat(document.getElementById("input-cutoff").value) || 0.0;
                
                let calculatedTier = "Moderate"; // Default
                const branchCutoffHist = data.branches_cutoff && data.branches_cutoff[branch] && data.branches_cutoff[branch][community];
                if (branchCutoffHist && userCutoff > 0) {
                    // Find latest available cutoff bound
                    let lastCutoff = null;
                    const years = ["2025", "2024", "2023", "2022", "2021"];
                    for (const yr of years) {
                        if (branchCutoffHist[yr] !== undefined && branchCutoffHist[yr] !== null) {
                            lastCutoff = branchCutoffHist[yr];
                            break;
                        }
                    }
                    if (lastCutoff !== null) {
                        if (userCutoff >= lastCutoff + 5) {
                            calculatedTier = "Safe";
                        } else if (userCutoff >= lastCutoff - 5) {
                            calculatedTier = "Moderate";
                        } else {
                            calculatedTier = "Dream";
                        }
                    }
                }
                
                addToChoice({
                    code: code,
                    name: name,
                    branch: branch,
                    district: district,
                    tier: calculatedTier,
                    cutoff: userCutoff > 0 ? userCutoff : "N/A"
                });
            });
        });

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

    // Advisor elements
    const advisorCard = document.getElementById("counselling-advisor-card");

    try {
        const response = await fetch(`${API_URL}/choice/${sessionId}`);
        const choices = await response.json();
        
        container.innerHTML = "";
        
        // Compute safety statistics
        const total = choices.length;
        let safeCount = 0;
        let moderateCount = 0;
        let dreamCount = 0;

        choices.forEach(c => {
            if (c.tier) {
                const tier = c.tier.toLowerCase();
                if (tier === "safe") safeCount++;
                else if (tier === "moderate") moderateCount++;
                else if (tier === "dream") dreamCount++;
            } else {
                moderateCount++;
            }
        });

        // Update Stats Dashboard numbers
        document.getElementById("stat-total-choices").textContent = total;
        document.getElementById("stat-safe-choices").textContent = safeCount;
        document.getElementById("stat-moderate-choices").textContent = moderateCount;
        document.getElementById("stat-dream-choices").textContent = dreamCount;

        if (total === 0) {
            container.innerHTML = '<div class="empty-state">Your choice list is empty. Add colleges from the Finder or Directory.</div>';
            if (advisorCard) {
                advisorCard.className = "advisor-card hidden";
                advisorCard.innerHTML = "";
            }
            return;
        }

        // Render Strategy Advisor message
        if (advisorCard) {
            advisorCard.className = "advisor-card"; // Reset hidden state
            
            if (total < 3) {
                advisorCard.classList.add("info");
                advisorCard.innerHTML = `
                    <div class="advisor-icon" style="color: #60a5fa;"><i class="fas fa-exclamation-circle"></i></div>
                    <div class="advisor-body">
                        <h4 style="color: #60a5fa; margin-bottom: 0.25rem; font-size: 0.95rem;"><i class="fas fa-robot"></i> Counselling Advisor: Sheet Incomplete</h4>
                        <p style="margin: 0; font-size: 0.8rem; line-height: 1.4; color: var(--text-secondary);">You have only <b>${total}</b> option(s) in your choice list. A robust TNEA strategy typically lists <b>15+ branch choices</b> to secure placements. Add more colleges from the <b>College Finder</b> or <b>Directory</b>!</p>
                    </div>
                `;
            } else if (safeCount === 0) {
                advisorCard.classList.add("danger");
                advisorCard.innerHTML = `
                    <div class="advisor-icon" style="color: #ef4444;"><i class="fas fa-radiation"></i></div>
                    <div class="advisor-body">
                        <h4 style="color: #ef4444; margin-bottom: 0.25rem; font-size: 0.95rem;"><i class="fas fa-shield-alt"></i> Counselling Advisor: No Safe Backups!</h4>
                        <p style="margin: 0; font-size: 0.8rem; line-height: 1.4; color: var(--text-secondary);">Your draft contains <b>zero "Safe" options</b>. If cutoffs spike, you risk <b>losing a seat completely</b> in this round. Please bookmark at least <b>3-4 Safe choices</b> (where your cutoff is higher by +5 points) to safeguard your future.</p>
                    </div>
                `;
            } else if (dreamCount > total * 0.7) {
                advisorCard.classList.add("warning");
                advisorCard.innerHTML = `
                    <div class="advisor-icon" style="color: #f59e0b;"><i class="fas fa-meteor"></i></div>
                    <div class="advisor-body">
                        <h4 style="color: #f59e0b; margin-bottom: 0.25rem; font-size: 0.95rem;"><i class="fas fa-exclamation-triangle"></i> Counselling Advisor: High Dream Ratio</h4>
                        <p style="margin: 0; font-size: 0.8rem; line-height: 1.4; color: var(--text-secondary);">Over <b>70%</b> of your choices are <b>"Dream" (aspirational reach)</b>. While it is good to aim high, you need a stronger foundation. Add more <b>Moderate</b> and <b>Safe</b> backups inside priorities 4-10 to balance your risk.</p>
                    </div>
                `;
            } else {
                advisorCard.classList.add("success");
                advisorCard.innerHTML = `
                    <div class="advisor-icon" style="color: #10b981;"><i class="fas fa-shield-halved"></i></div>
                    <div class="advisor-body">
                        <h4 style="color: #10b981; margin-bottom: 0.25rem; font-size: 0.95rem;"><i class="fas fa-check-circle"></i> Counselling Advisor: Excellent Strategy</h4>
                        <p style="margin: 0; font-size: 0.8rem; line-height: 1.4; color: var(--text-secondary);">Your choice list is beautifully balanced! You have <b>${dreamCount} Dream</b>, <b>${moderateCount} Moderate</b>, and <b>${safeCount} Safe</b> backups. This layout ensures you reach for top schools while maintaining an ironclad safety net.</p>
                    </div>
                `;
            }
        }

        choices.forEach((c, index) => {
            const card = document.createElement("div");
            card.className = "college-card choice-item";
            
            const isFirst = index === 0;
            const isLast = index === choices.length - 1;
            
            let badgeHtml = "";
            if (c.tier) {
                const tierClass = c.tier.toLowerCase();
                let iconClass = "fa-check-circle";
                if (tierClass === "safe") iconClass = "fa-check-double";
                if (tierClass === "dream") iconClass = "fa-star";
                badgeHtml = `<span class="probability-badge ${tierClass}"><i class="fas ${iconClass}"></i> ${c.tier}</span>`;
            }

            card.innerHTML = `
                <div style="display: flex; flex-direction: column; width: 100%; gap: 0.75rem;">
                    <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 1rem;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; flex: 1; min-width: 0;">
                            <!-- Priority Up/Down Controls -->
                            <div class="choice-reorder-controls">
                                <button class="choice-reorder-btn reorder-up-btn" ${isFirst ? 'disabled' : ''} title="Move Up"><i class="fas fa-chevron-up"></i></button>
                                <button class="choice-reorder-btn reorder-down-btn" ${isLast ? 'disabled' : ''} title="Move Down"><i class="fas fa-chevron-down"></i></button>
                            </div>
                            
                            <div class="choice-index" style="background: var(--primary); width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; flex-shrink: 0; box-shadow: 0 4px 10px var(--primary-glow);">${index + 1}</div>
                            <div style="flex: 1; min-width: 0;">
                                <h4 style="margin-bottom: 0.35rem; font-size: 1.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${c.name}</h4>
                                <div class="location-tag" style="display: flex; flex-wrap: wrap; gap: 0.8rem; font-size: 0.78rem; align-items: center;">
                                    <span><i class="fas fa-university"></i> CODE: ${c.code}</span>
                                    <span>&bull;</span>
                                    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;"><i class="fas fa-graduation-cap"></i> ${c.branch}</span>
                                    <span>&bull;</span>
                                    <span><i class="fas fa-map-marker-alt"></i> ${c.district || 'Tamil Nadu'}</span>
                                </div>
                            </div>
                        </div>
                        
                        <div style="display: flex; align-items: center; gap: 1rem; flex-shrink: 0;">
                            ${badgeHtml}
                            <button class="btn-secondary remove-choice-btn" style="width: auto; padding: 0.6rem 0.9rem; border-color: rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: var(--border-radius-md);" title="Remove from list">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Notes / Remarks Frosted Input Row -->
                    <div class="choice-remarks-container" style="display: flex; align-items: center; gap: 0.5rem; width: 100%; border-top: 1px dashed rgba(255, 255, 255, 0.1); padding-top: 0.65rem;">
                        <span style="font-size: 0.75rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; flex-shrink: 0; font-weight: 600;"><i class="fas fa-edit"></i> Remarks:</span>
                        <input type="text" 
                               class="choice-remarks-input" 
                               style="flex: 1; font-size: 0.8rem; padding: 0.4rem 0.65rem; border-radius: var(--border-radius-sm); border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); color: var(--text-primary); transition: all 0.2s;"
                               placeholder="Add private remarks (e.g., 'Aided seat', 'Admissions Helpline: 044-xxxx', 'Highly preferred')" 
                               value="${c.notes || ''}">
                    </div>
                    
                    <!-- Print-only Remarks text -->
                    <div class="print-only-remarks" style="display: none; font-size: 0.8rem; font-style: italic; margin-top: 0.45rem; border-top: 1px dashed #ccc; padding-top: 0.45rem; color: #333;">
                        <strong>Remarks:</strong> ${c.notes || 'None'}
                    </div>
                </div>
            `;
            
            // Reorder click events
            card.querySelector(".reorder-up-btn")?.addEventListener("click", async (e) => {
                e.stopPropagation();
                await reorderChoiceItem("up", index);
            });
            card.querySelector(".reorder-down-btn")?.addEventListener("click", async (e) => {
                e.stopPropagation();
                await reorderChoiceItem("down", index);
            });

            card.querySelector(".remove-choice-btn").addEventListener("click", async (e) => {
                e.stopPropagation();
                await removeChoiceItem({
                    code: c.code,
                    branch: c.branch,
                    name: c.name
                });
            });

            // Notes auto-save listener on change and blur
            const remarksInput = card.querySelector(".choice-remarks-input");
            const printRemarks = card.querySelector(".print-only-remarks");
            const saveNotes = async () => {
                const notesVal = remarksInput.value.trim();
                if (c.notes !== notesVal) {
                    try {
                        await fetch(`${API_URL}/choice/notes?session_id=${sessionId}&index=${index}&notes=${encodeURIComponent(notesVal)}`, {
                            method: "POST"
                        });
                        c.notes = notesVal; // cache locally
                        if (printRemarks) {
                            printRemarks.innerHTML = `<strong>Remarks:</strong> ${notesVal || 'None'}`;
                        }
                    } catch (error) {
                        console.error("Failed to save choice note:", error);
                    }
                }
            };
            remarksInput?.addEventListener("change", saveNotes);
            remarksInput?.addEventListener("blur", saveNotes);
            
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

// Reorder choice priority ranking
async function reorderChoiceItem(direction, index) {
    try {
        const response = await fetch(`${API_URL}/choice/reorder?session_id=${sessionId}&direction=${direction}&index=${index}`, {
            method: "POST"
        });
        if (response.ok) {
            loadChoices();
        } else {
            showToast("Failed to reorder choice list.", "error");
        }
    } catch (error) {
        showToast("Error reordering choices.", "error");
    }
}

// Generate and trigger download of CSV spreadsheet of choices
function downloadChoiceListAsCSV(choices) {
    let csvContent = "\uFEFFPriority,College Code,College Name,Branch/Course,District,Type/Tier,Personal Remarks\n";
    choices.forEach((c, index) => {
        const row = [
            index + 1,
            c.code || "",
            `"${(c.name || "").replace(/"/g, '""')}"`,
            `"${(c.branch || "").replace(/"/g, '""')}"`,
            c.district || "",
            c.tier || "N/A",
            `"${(c.notes || "").replace(/"/g, '""')}"`
        ];
        csvContent += row.join(",") + "\n";
    });
    
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `TNEA_Choice_List_${sessionId.slice(0,8)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Generate and trigger download of TXT choice guide
function downloadChoiceListAsTXT(choices) {
    let txtContent = "====================================================\n";
    txtContent += "              TNEA AI COUNSELLING CHOICE LIST       \n";
    txtContent += `Session ID: ${sessionId}\n`;
    txtContent += `Generated On: ${new Date().toLocaleString()}\n`;
    txtContent += "====================================================\n\n";
    
    choices.forEach((c, index) => {
        txtContent += `${index + 1}. [CODE: ${c.code}] ${c.name}\n`;
        txtContent += `   Course: ${c.branch}\n`;
        txtContent += `   District: ${c.district || 'Tamil Nadu'}\n`;
        if (c.tier) {
            txtContent += `   Admissions Probability: ${c.tier}\n`;
        }
        if (c.notes) {
            txtContent += `   Personal Remarks: ${c.notes}\n`;
        }
        txtContent += "----------------------------------------------------\n";
    });
    
    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `TNEA_Choice_List_${sessionId.slice(0,8)}.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ==========================================================================
// 10. Custom Multi-select Dropdown Components
// ==========================================================================

// Global click listener to close multi-selects when clicking outside
document.addEventListener("click", (e) => {
    const activeDropdown = document.querySelector(".custom-multi-select.active");
    if (activeDropdown && !activeDropdown.contains(e.target)) {
        activeDropdown.classList.remove("active");
    }
});

// Setup click triggers on all select dropdowns
function setupMultiSelectTriggers() {
    document.querySelectorAll(".custom-multi-select").forEach(select => {
        const trigger = select.querySelector(".select-trigger");
        trigger.addEventListener("click", (e) => {
            e.stopPropagation();
            const isActive = select.classList.contains("active");
            
            // Close any other active dropdowns first
            document.querySelectorAll(".custom-multi-select.active").forEach(other => {
                if (other !== select) other.classList.remove("active");
            });
            
            if (isActive) {
                select.classList.remove("active");
            } else {
                select.classList.add("active");
                // Focus search input on open
                setTimeout(() => {
                    select.querySelector(".dropdown-search input")?.focus();
                }, 50);
            }
        });
        
        // Prevent click inside dropdown from closing it (unless clicking options)
        const dropdown = select.querySelector(".select-dropdown");
        dropdown.addEventListener("click", (e) => {
            e.stopPropagation();
        });
    });
}

// Fetch districts and branches and populate the multi-select dropdowns dynamically
async function loadMetadata() {
    try {
        const response = await fetch(`${API_URL}/metadata`);
        const data = await response.json();
        
        // Populate Finder dropdowns
        populateMultiSelectOptions("finder-district-options", data.districts, "finder-district-select", false);
        populateMultiSelectOptions("finder-branch-options", data.branches, "finder-branch-select", false);
        
        // Populate Directory dropdowns (these trigger live filter reload)
        populateMultiSelectOptions("directory-district-options", data.districts, "directory-district-select", true);
        populateMultiSelectOptions("directory-branch-options", data.branches, "directory-branch-select", true);
        
        // Populate Cutoff Calculator dropdowns
        const calcDistrict = document.getElementById("calc-district");
        const calcBranch = document.getElementById("calc-branch");
        if (calcDistrict && data.districts) {
            calcDistrict.innerHTML = '<option value="All">All Districts (Tamil Nadu)</option>';
            data.districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d;
                opt.textContent = d;
                calcDistrict.appendChild(opt);
            });
        }
        if (calcBranch && data.branches) {
            calcBranch.innerHTML = '<option value="All">All Branches</option>';
            data.branches.forEach(b => {
                const opt = document.createElement("option");
                opt.value = b;
                opt.textContent = b;
                calcBranch.appendChild(opt);
            });
        }
        
        // Setup toggle handlers
        setupMultiSelectTriggers();
        // Setup search filter events inside dropdowns
        setupDropdownSearchFilters();
    } catch (error) {
        console.error("Error loading college metadata:", error);
    }
}

// Populate items with checkboxes into the select dropdown
function populateMultiSelectOptions(optionsContainerId, items, selectContainerId, triggerDirectoryReload = false) {
    const container = document.getElementById(optionsContainerId);
    if (!container) return;
    container.innerHTML = "";
    
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding: 0.5rem 1rem; font-size: 0.8rem;">No options available</div>';
        return;
    }
    
    items.forEach((item, index) => {
        const option = document.createElement("div");
        option.className = "dropdown-option";
        
        const checkboxId = `${selectContainerId}-opt-${index}`;
        option.innerHTML = `
            <input type="checkbox" id="${checkboxId}" value="${item}">
            <label for="${checkboxId}" style="cursor: pointer; width: 100%; display: flex; align-items: center;">
                <span>${item}</span>
            </label>
        `;
        
        const checkbox = option.querySelector('input[type="checkbox"]');
        
        // Allow clicking the entire option row to check the checkbox
        option.addEventListener("click", (e) => {
            if (e.target !== checkbox && e.target.tagName !== "LABEL") {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event("change"));
            }
        });
        
        checkbox.addEventListener("change", () => {
            updateMultiSelectLabel(selectContainerId);
            if (triggerDirectoryReload) {
                const searchVal = document.getElementById("directory-search")?.value || "";
                loadDirectory(searchVal);
            }
        });
        
        container.appendChild(option);
    });
}

// Filter dropdown list options as user types in the search box
function filterDropdownOptions(inputElement) {
    const term = inputElement.value.trim().toLowerCase();
    const dropdown = inputElement.closest(".select-dropdown");
    const options = dropdown.querySelectorAll(".dropdown-option");
    
    options.forEach(opt => {
        const text = opt.textContent.trim().toLowerCase();
        if (text.includes(term)) {
            opt.style.display = "flex";
        } else {
            opt.style.display = "none";
        }
    });
}

// Setup input listeners on search boxes inside custom multi-select dropdowns
function setupDropdownSearchFilters() {
    document.querySelectorAll(".custom-multi-select .dropdown-search input").forEach(input => {
        input.addEventListener("input", (e) => {
            filterDropdownOptions(e.target);
        });
    });
}

// Retrieve selected values from a given custom multi-select container
function getSelectedMultiSelectValues(selectContainerId) {
    const container = document.getElementById(selectContainerId);
    if (!container) return [];
    
    const checkboxes = container.querySelectorAll('.dropdown-options input[type="checkbox"]:checked');
    const selected = [];
    checkboxes.forEach(cb => selected.push(cb.value));
    return selected;
}

// Update trigger label and badge counter dynamically
function updateMultiSelectLabel(selectContainerId) {
    const container = document.getElementById(selectContainerId);
    if (!container) return;
    
    const label = container.querySelector(".trigger-label");
    const badge = container.querySelector(".trigger-badge");
    const selected = getSelectedMultiSelectValues(selectContainerId);
    
    let defaultText = "Select Option";
    if (selectContainerId.includes("district")) {
        defaultText = selectContainerId.includes("finder") ? "Select Districts" : "Filter Districts";
    } else if (selectContainerId.includes("branch")) {
        defaultText = selectContainerId.includes("finder") ? "Select Branches" : "Filter Branches";
    }
    
    if (selected.length === 0) {
        label.textContent = defaultText;
        badge.style.display = "none";
    } else {
        if (selected.length <= 2) {
            label.textContent = selected.join(", ");
        } else {
            label.textContent = `${selected.slice(0, 2).join(", ")} +${selected.length - 2} more`;
        }
        badge.textContent = selected.length;
        badge.style.display = "inline-block";
    }
}

// Programmatically select/unselect — fires change events (use for user-visible interactions)
function selectMultiSelectOption(selectContainerId, optionValue) {
    const container = document.getElementById(selectContainerId);
    if (!container) return;
    
    const checkboxes = container.querySelectorAll('.dropdown-options input[type="checkbox"]');
    checkboxes.forEach(cb => {
        const newState = (optionValue && cb.value.toLowerCase() === optionValue.toLowerCase());
        if (cb.checked !== newState) {
            cb.checked = newState;
            // Only dispatch change when state actually changes to avoid no-op floods
            cb.dispatchEvent(new Event("change"));
        }
    });
    updateMultiSelectLabel(selectContainerId);
}

// Silent variant — sets checkbox state WITHOUT firing change events.
// Use this when batching multiple filter changes before a single loadDirectory() call.
function selectMultiSelectOptionSilent(selectContainerId, optionValue) {
    const container = document.getElementById(selectContainerId);
    if (!container) return;
    const checkboxes = container.querySelectorAll('.dropdown-options input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = (optionValue && cb.value.toLowerCase() === optionValue.toLowerCase());
    });
}
