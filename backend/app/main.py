from fastapi import FastAPI, Depends, HTTPException, Request, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional, Dict
import time
import ollama
import torch
from sqlalchemy.orm import Session
from .database import SessionLocal, College, TFCCenter, Contact, Course, HostelDetails, TransportDetails, CollegeCutoff
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

app = FastAPI(title="TNEA Pro Counselling AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- In-Memory Cache & Memory ---
USER_SESSIONS: Dict[str, dict] = {} # {session_id: {cutoff, category, choices: []}}
USER_CHOICES: Dict[str, List[dict]] = {} # {session_id: [choice_data]}

# --- Directory response cache (TTL = 300 seconds) ---
# Key: (search, tuple(sorted districts), tuple(sorted branches))
# Value: {"ts": float, "result": List[dict]}
_DIRECTORY_CACHE: Dict[tuple, dict] = {}
_DIRECTORY_CACHE_TTL = 300  # seconds

def _get_directory_cache(key: tuple):
    entry = _DIRECTORY_CACHE.get(key)
    if entry and (time.time() - entry["ts"]) < _DIRECTORY_CACHE_TTL:
        return entry["result"]
    return None

def _set_directory_cache(key: tuple, result: list):
    _DIRECTORY_CACHE[key] = {"ts": time.time(), "result": result}
    # Keep cache small — evict if too many keys
    if len(_DIRECTORY_CACHE) > 200:
        oldest = min(_DIRECTORY_CACHE, key=lambda k: _DIRECTORY_CACHE[k]["ts"])
        del _DIRECTORY_CACHE[oldest]

# --- GPU & Embeddings ---
# FORCE CPU for embeddings to save VRAM for Ollama (llama3)
# This prevents the "Ollama GPU/Memory Error" on most systems.
device = "cpu"
CHROMA_PATH = "backend/data/db/chroma_db"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
embeddings = HuggingFaceEmbeddings(
    model_name=EMBEDDING_MODEL, 
    model_kwargs={'device': device, 'local_files_only': True}
)
vector_db = Chroma(persist_directory=CHROMA_PATH, embedding_function=embeddings, collection_name="tnea_docs")
print(f"--- Embeddings initialized on device: {device} ---")

# --- Dynamic Branch Discovery ---
# We load all unique branches from the DB to ensure we can match ANY branch
ALL_BRANCHES = []
def load_branches():
    global ALL_BRANCHES
    try:
        db = SessionLocal()
        branches = db.query(CollegeCutoff.branch_name).distinct().all()
        ALL_BRANCHES = [b[0].upper() for b in branches if b[0]]
        print(f"--- Loaded {len(ALL_BRANCHES)} unique branches from database ---")
        db.close()
    except Exception as e:
        print(f"Error loading branches: {e}")

load_branches()

def apply_branch_filter(query, branch_clean: str):
    if not branch_clean:
        return query
    from sqlalchemy import or_, func
    b_norm = branch_clean.strip().upper()
    
    if b_norm in ["IT", "INFORMATION TECHNOLOGY"]:
        return query.filter(CollegeCutoff.branch_name.ilike("%Information Technology%"))
    elif b_norm in ["CSE", "CS", "COMPUTER SCIENCE", "COMPUTER SCIENCE AND ENGINEERING"]:
        return query.filter(or_(
            CollegeCutoff.branch_name.ilike("%Computer Science%"),
            CollegeCutoff.branch_name.ilike("%Computer Science and Engineering%"),
            CollegeCutoff.branch_name.ilike("%Computer Science & Engineering%")
        ))
    elif b_norm in ["AIDS", "AD", "AI&DS", "AI-DS", "AI AND DS", "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE"]:
        return query.filter(or_(
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence and Data Science%"),
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence & Data Science%"),
            CollegeCutoff.branch_name.ilike("%AI%DS%"),
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence and Data Science (SS)%")
        ))
    elif b_norm in ["AIML", "AI&ML", "AI-ML", "AI AND ML", "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING"]:
        return query.filter(or_(
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence and Machine Learning%"),
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence & Machine Learning%"),
            CollegeCutoff.branch_name.ilike("%AI%ML%")
        ))
    elif b_norm in ["BM", "BME", "BIOMEDICAL", "BIOMEDICAL ENGINEERING", "BIO MEDICAL ENGINEERING"]:
        return query.filter(or_(
            CollegeCutoff.branch_name.ilike("%Bio Medical Engineering%"),
            CollegeCutoff.branch_name.ilike("%Biomedical Engineering%")
        ))
def get_branch_filter_condition(branch_clean: str):
    from sqlalchemy import or_, func
    b_norm = branch_clean.strip().upper()
    
    if b_norm in ["IT", "INFORMATION TECHNOLOGY"]:
        return CollegeCutoff.branch_name.ilike("%Information Technology%")
    elif b_norm in ["CSE", "CS", "COMPUTER SCIENCE", "COMPUTER SCIENCE AND ENGINEERING"]:
        return or_(
            CollegeCutoff.branch_name.ilike("%Computer Science%"),
            CollegeCutoff.branch_name.ilike("%Computer Science and Engineering%"),
            CollegeCutoff.branch_name.ilike("%Computer Science & Engineering%")
        )
    elif b_norm in ["AIDS", "AD", "AI&DS", "AI-DS", "AI AND DS", "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE"]:
        return or_(
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence and Data Science%"),
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence & Data Science%"),
            CollegeCutoff.branch_name.ilike("%AI%DS%"),
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence and Data Science (SS)%")
        )
    elif b_norm in ["AIML", "AI&ML", "AI-ML", "AI AND ML", "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING"]:
        return or_(
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence and Machine Learning%"),
            CollegeCutoff.branch_name.ilike("%Artificial Intelligence & Machine Learning%"),
            CollegeCutoff.branch_name.ilike("%AI%ML%")
        )
    elif b_norm in ["BM", "BME", "BIOMEDICAL", "BIOMEDICAL ENGINEERING", "BIO MEDICAL ENGINEERING"]:
        return or_(
            CollegeCutoff.branch_name.ilike("%Bio Medical Engineering%"),
            CollegeCutoff.branch_name.ilike("%Biomedical Engineering%")
        )
    else:
        return func.replace(CollegeCutoff.branch_name, ".", "").ilike(f"%{branch_clean}%")

# --- Models ---
class QueryRequest(BaseModel):
    query: Optional[str] = None
    session_id: Optional[str] = "default"
    category: Optional[str] = "OC"
    cutoff: Optional[float] = 0.0
    district: Optional[str] = None
    branch: Optional[str] = None
    districts: Optional[List[str]] = None
    branches: Optional[List[str]] = None

class RecommendationResponse(BaseModel):
    college_code: int
    college_name: str
    branch_name: str
    district: str
    cutoff: str
    history: Optional[dict] = {}
    reason: str
    tier: str # Safe, Moderate, Dream
    label: Optional[str] = ""
    proximity: Optional[float] = 0.0

# --- Core Logic ---

# --- Core Logic ---

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

@app.post("/recommend", response_model=List[RecommendationResponse])
async def recommend_endpoint(request: QueryRequest, db: Session = Depends(get_db)):
    cutoff = request.cutoff if request.cutoff is not None else 0.0
    # Save to session memory
    USER_SESSIONS[request.session_id] = {"cutoff": cutoff, "category": request.category}

    # 1. Primary Search - Prioritize 2025 data, fallback to 2024
    query = db.query(CollegeCutoff).filter((CollegeCutoff.cutoff_2025 > 0) | (CollegeCutoff.cutoff_2024 > 0)).filter(CollegeCutoff.branch_name.isnot(None))
    
    # Normalize input
    dist_clean = request.district.strip().replace(".", "") if request.district else ""
    branch_clean = request.branch.strip().upper().replace(".", "") if request.branch else ""
    
    # Apply filters if provided
    if request.category:
        query = query.filter(CollegeCutoff.category == request.category)
    
    # Multi-district selection support
    if request.districts:
        from sqlalchemy import or_, func
        dist_conditions = []
        for d in request.districts:
            d_clean = d.strip().replace(".", "")
            if d_clean:
                dist_conditions.append(func.replace(CollegeCutoff.district, ".", "").ilike(f"%{d_clean}%"))
        if dist_conditions:
            query = query.filter(or_(*dist_conditions))
    elif dist_clean:
        from sqlalchemy import func
        query = query.filter(func.replace(CollegeCutoff.district, ".", "").ilike(f"%{dist_clean}%"))
    
    # Multi-branch selection support
    if request.branches:
        from sqlalchemy import or_
        branch_conditions = []
        for b in request.branches:
            b_clean = b.strip().upper().replace(".", "")
            if b_clean:
                branch_conditions.append(get_branch_filter_condition(b_clean))
        if branch_conditions:
            query = query.filter(or_(*branch_conditions))
    elif branch_clean:
        query = query.filter(get_branch_filter_condition(branch_clean))
    
    results = query.all()
    print(f"DEBUG: Found {len(results)} total matching records for processing.")

    # 2. Relaxed Fallback (If no results in district, search statewide)
    if not results and (request.district or request.districts):
        print(f"DEBUG: Falling back to statewide search.")
        query = db.query(CollegeCutoff).filter(CollegeCutoff.cutoff_2023 > 0)
        if request.category: query = query.filter(CollegeCutoff.category == request.category)
        
        # Apply branch filters for fallback
        if request.branches:
            from sqlalchemy import or_
            branch_conditions = []
            for b in request.branches:
                b_clean = b.strip().upper().replace(".", "")
                if b_clean:
                    branch_conditions.append(get_branch_filter_condition(b_clean))
            if branch_conditions:
                query = query.filter(or_(*branch_conditions))
        elif branch_clean:
            query = query.filter(get_branch_filter_condition(branch_clean))
            
        results = query.limit(500).all() # Get a large pool for fallback

    # Group by College + Branch to avoid duplicates and show ranges
    grouped = {}
    for col in results:
        key = (col.college_name, col.branch_name)
        if key not in grouped:
            grouped[key] = {
                "col": col,
                "cutoffs": []
            }
        # Always store full history for trends, even if latest is missing
        grouped[key]["history"] = {
            "2021": col.cutoff_2021,
            "2022": col.cutoff_2022,
            "2023": col.cutoff_2023,
            "2024": col.cutoff_2024,
            "2025": col.cutoff_2025
        }
        
        # Track the latest available cutoff for range calculation
        latest_c = col.cutoff_2025 or col.cutoff_2024 or col.cutoff_2023
        if latest_c:
            grouped[key]["cutoffs"].append(latest_c)

    recommendations = []
    for (c_name, b_name), data in grouped.items():
        col = data["col"]
        cutoffs = data["cutoffs"]
        if not cutoffs:
            continue
        min_c = min(cutoffs)
        max_c = max(cutoffs)
        
        # Use max_c for proximity/tiering logic as it's the most competitive
        diff = cutoff - max_c
        
        # Friendly Suggester Logic (Balanced thresholds)
        if diff >= 1:
            tier = "Safe"
            label = "High Probability"
            reason = f"Excellent match! Your score of {cutoff} is above the {max_c} cutoff. Very high chance of admission."
        elif -2 <= diff < 1:
            tier = "Moderate"
            label = "Good Match"
            reason = f"Perfect match! This range ({min_c}-{max_c}) fits your score perfectly. Highly recommended."
        elif -10 <= diff < -2:
            tier = "Dream"
            label = "Aspirational Reach"
            reason = f"Great target! This is slightly ambitious but definitely worth a shot in early rounds."
        else: continue
            
        # Format the cutoff display (Single value if same, or Range if different)
        cutoff_display = f"{min_c} - {max_c}" if min_c != max_c else f"{min_c}"
            
        recommendations.append({
            "college_code": int(col.college_code) if col.college_code else 0,
            "college_name": c_name,
            "branch_name": b_name or "General",
            "district": col.district,
            "cutoff": cutoff_display,
            "history": data.get("history", {}),
            "raw_cutoff": max_c,
            "reason": reason,
            "tier": tier,
            "label": label,
            "proximity": abs(diff)
        })
    
    # SMART SORTING: Prioritize colleges closest to the user's cutoff
    recommendations.sort(key=lambda x: x['proximity'])
    
    return recommendations[:50]

@app.post("/chat")
async def chat_endpoint(request: QueryRequest, db: Session = Depends(get_db)):
    raw_query = request.query.strip()
    query_lower = raw_query.lower()
    session_id = request.session_id

    # Conversational Memory Lookup
    session = USER_SESSIONS.get(session_id, {})
    user_cutoff = request.cutoff if request.cutoff is not None else session.get("cutoff", 0.0)
    user_cat = request.category if request.category else session.get("category", "OC")

    # -----------------------------------------------------------------
    # SMART QUERY INTENT DETECTION
    # -----------------------------------------------------------------
    query_norm = query_lower.upper().replace(".", "").replace("?", "").replace("&", " AND ").replace("-", " ")
    q_words = query_norm.split()

    # Intent flags
    is_fee_query = any(w in query_lower for w in ["fee", "fees", "tuition", "cost", "payment", "challan"])
    is_scholarship_query = any(w in query_lower for w in ["scholarship", "concession", "free seat", "first graduate", "7.5"])
    is_counselling_query = any(w in query_lower for w in ["process", "stages", "schedule", "round", "counselling", "counseling", "option filling", "allotment", "document", "verification"])
    is_rank_query = any(w in query_lower for w in ["rank", "marks", "cutoff", "mark", "score"])
    is_tfc_query = any(w in query_lower for w in ["tfc", "facilitation", "center", "centre", "help center"])
    is_category_query = any(w in query_lower for w in ["oc", "bc", "mbc", "sc", "sca", "st", "category", "reservation"])
    is_greeting = query_lower.strip() in ["hi", "hello", "hey", "who are you", "what can you do"]

    # Branch detection
    branch_filter = None
    branch_map = {
        "AIDS": "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE",
        "AD": "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE",
        "AI AND DS": "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE",
        "AIML": "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING",
        "AI AND ML": "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING",
        "CSE": "COMPUTER SCIENCE AND ENGINEERING",
        "CS": "COMPUTER SCIENCE AND ENGINEERING",
        "IT": "INFORMATION TECHNOLOGY",
        "ECE": "ELECTRONICS AND COMMUNICATION ENGINEERING",
        "EEE": "ELECTRICAL AND ELECTRONICS ENGINEERING",
        "MECH": "MECHANICAL ENGINEERING",
        "CIVIL": "CIVIL ENGINEERING",
        "BM": "BIO MEDICAL ENGINEERING",
        "BME": "BIO MEDICAL ENGINEERING",
        "AI": "ARTIFICIAL INTELLIGENCE",
        "DS": "DATA SCIENCE",
        "CHEM": "CHEMICAL ENGINEERING",
        "AERO": "AERONAUTICAL ENGINEERING",
        "AUTO": "AUTOMOBILE ENGINEERING",
        "BIOTECH": "BIOTECHNOLOGY",
        "MBA": "MBA",
        "MCA": "MCA",
    }
    for abbr, full in branch_map.items():
        if abbr in q_words or f" {abbr} " in f" {query_norm} ":
            branch_filter = full
            break
    if not branch_filter:
        for b_name in ALL_BRANCHES:
            b_norm = b_name.replace(".", "").upper()
            if b_norm in query_norm:
                branch_filter = b_name
                break

    # Words that are noise for college search (keep narrow — don't block "FEES")
    NOISE_WORDS = {
        "COLLEGE", "INSTITUTE", "ACADEMY", "UNIVERSITY", "AND", "OF", "THE",
        "TELL", "WHAT", "NAME", "SHOW", "LIST", "ABOUT", "GIVE", "FIND",
        "THESE", "THOSE", "WITH", "FOR", "FROM", "HAVE", "DOES", "WILL",
        "PLEASE", "HELP", "KNOW", "WANT", "NEED", "HOW", "WHEN", "WHERE"
    }
    selective_words = [w for w in q_words if w not in NOISE_WORDS and len(w) >= 3]
    is_general_query = not selective_words or all(
        any(w in q for q in [
            "process", "stage", "counselling", "counseling", "fee", "fees",
            "scholarship", "document", "eligibility", "reservation", "round",
            "option", "seat", "allot", "tfc", "category"
        ])
        for w in [s.lower() for s in selective_words]
    )

    # -----------------------------------------------------------------
    # SQL RETRIEVAL — only if it's plausibly a college-specific query
    # -----------------------------------------------------------------
    sql_context = ""
    if not is_general_query:
        from sqlalchemy import func
        matches = []
        for word in selective_words[:5]:  # limit to first 5 meaningful words
            q_sql = db.query(CollegeCutoff).filter(
                func.replace(CollegeCutoff.college_name, ".", "").ilike(f"%{word}%")
            )
            if branch_filter:
                q_sql = q_sql.filter(CollegeCutoff.branch_name.ilike(f"%{branch_filter}%"))
            matches.extend(q_sql.limit(400).all())
            if len(matches) >= 1500:
                break

        # De-duplicate and group by college + branch
        c_grouped = {}
        for m in matches:
            b_key = (m.college_name, m.branch_name)
            if b_key not in c_grouped:
                if len(c_grouped) >= 12:
                    break
                c_grouped[b_key] = {
                    "college_code": m.college_code,
                    "district": m.district,
                    "history": {"2025": [], "2024": [], "2023": [], "2022": [], "2021": []}
                }
            for yr in ["2021", "2022", "2023", "2024", "2025"]:
                val = getattr(m, f"cutoff_{yr}", None)
                if val:
                    c_grouped[b_key]["history"][yr].append(val)

        for (c_n, b_n), data in list(c_grouped.items())[:15]:
            year_parts = []
            for year in ["2025", "2024", "2023", "2022", "2021"]:
                vals = data["history"][year]
                if not vals:
                    continue
                lo, hi = min(vals), max(vals)
                year_parts.append(f"{year}: {lo if lo == hi else f'{lo}–{hi}'}")
            if year_parts:
                sql_context += (
                    f"\n• {c_n} (Code {data['college_code']}, {data['district']}) | "
                    f"{b_n or 'General'} | Cutoffs — {', '.join(year_parts)}"
                )

        if not sql_context and matches:
            for m in matches[:8]:
                latest = m.cutoff_2025 or m.cutoff_2024 or m.cutoff_2023 or "N/A"
                sql_context += f"\n• {m.branch_name} | Latest Cutoff: {latest}"

    # -----------------------------------------------------------------
    # VECTOR / RAG RETRIEVAL
    # -----------------------------------------------------------------
    try:
        # Use a higher k for process/fee/general queries
        k_val = 15 if is_general_query or is_fee_query or is_counselling_query else 8
        docs = vector_db.similarity_search(raw_query, k=k_val)
    except Exception:
        docs = []

    vector_context = "\n\n".join([d.page_content for d in docs])
    citations = list(set(
        f"{d.metadata.get('source')} (Page {d.metadata.get('page')})"
        for d in docs
        if d.metadata.get("source")
    ))

    # -----------------------------------------------------------------
    # GREETING SHORTCUT
    # -----------------------------------------------------------------
    if is_greeting:
        return {
            "answer": (
                "Hello! I'm your TNEA Pro AI counselling assistant. I can help you with:\n\n"
                "- **College & Branch Cutoff History** — see past cutoff marks for any college or branch\n"
                "- **Personalized Recommendations** — get Safe / Moderate / Dream college suggestions based on your score\n"
                "- **Counselling Process** — understand the rounds, document verification, option filling, and allotment\n"
                "- **Fees & Scholarships** — government tuition fee details, first-generation concessions, and more\n"
                "- **TFC Center Info** — find facilitation centers near you for document help\n\n"
                "What would you like to know? 😊"
            ),
            "sources": [],
            "strategy_alert": ""
        }

    # -----------------------------------------------------------------
    # COMPOSE FULL CONTEXT
    # -----------------------------------------------------------------
    context_parts = []
    if sql_context:
        context_parts.append(f"=== College Database Records ===\n{sql_context}")
    if vector_context:
        context_parts.append(f"=== Knowledge Base (PDF / Documents) ===\n{vector_context}")
    full_context = "\n\n".join(context_parts) if context_parts else "No specific records found in the database for this query."

    # -----------------------------------------------------------------
    # SYSTEM PROMPT — expert persona, warm tone, structured output
    # -----------------------------------------------------------------
    system_prompt = """You are TNEA Pro AI — a warm, knowledgeable, and highly experienced TNEA (Tamil Nadu Engineering Admissions) counsellor with 10+ years of expertise.

Your personality:
- Friendly and encouraging, never cold or bureaucratic
- Structured but conversational — like a wise senior mentor explaining to a student
- Honest about limitations without being dismissive
- Always suggest a next practical step

Your knowledge:
- You have deep expertise in TNEA counselling rounds, option filling strategy, seat allotment, document verification
- You know government college fee structures, BC/MBC/SC/ST scholarship schemes, first-graduate concessions, and the 7.5% quota
- You understand cutoff mark patterns across all districts and branches from 2021–2025
- You know how TFC (TNEA Facilitation Centers) work and their role in the process

Output format rules:
- Use **bold** for key terms, numbers, and college names
- Use bullet points or numbered steps for processes
- Use short paragraphs — never walls of text
- When data is available, present it as a clean summary with years
- When data is NOT in context, use your expert knowledge but clearly say "Based on general TNEA guidelines..."
- NEVER say "I couldn't find this in my records" as a full answer — always supplement with what you DO know
- NEVER produce generic placeholder text. Be specific and actionable.
- End with a helpful follow-up suggestion or question when appropriate"""

    user_prompt = f"""Student Profile: Cutoff Mark = {user_cutoff or 'Not set'}, Category = {user_cat or 'OC'}

Context from Knowledge Base:
{full_context}

Student's Question: {raw_query}

Please answer directly and helpfully. If the context has relevant data, use it precisely. If not, draw on your expert knowledge of TNEA and clearly indicate it. Be warm, structured, and end with a helpful next step."""

    # -----------------------------------------------------------------
    # LLM CALL
    # -----------------------------------------------------------------
    try:
        if groq_client:
            print("--- Attempting Groq (Llama-3.3-70b) ---")
            chat_completion = groq_client.chat.completions.create(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                model="llama-3.3-70b-versatile",
                temperature=0.4,
                max_tokens=1024,
            )
            full_response = chat_completion.choices[0].message.content.strip()
        else:
            raise Exception("No Groq API Key found")

    except Exception as e:
        print(f"--- Groq Failed, falling back to Ollama --- Error: {e}")
        try:
            combined_prompt = f"{system_prompt}\n\n{user_prompt}"
            response = ollama.chat(model='phi3', messages=[{'role': 'user', 'content': combined_prompt}])
            full_response = response['message']['content'].strip()
        except Exception as ollama_e:
            error_msg = str(ollama_e).lower()
            if "connection" in error_msg or "refused" in error_msg:
                return {
                    "answer": "I'm having trouble reaching the AI engine right now. Please make sure the Ollama service is running and try again in a moment.",
                    "sources": [],
                    "strategy_alert": "Tip: Open the Ollama app and ensure the service is active."
                }
            return {"answer": f"Unexpected error: {str(ollama_e)}", "sources": []}

    # Generate a strategy tip for cutoff-related queries
    strategy_alert = ""
    if user_cutoff and (is_rank_query or is_general_query) and float(user_cutoff) > 0:
        if float(user_cutoff) >= 190:
            strategy_alert = f"With a cutoff of {user_cutoff}, you're in a strong position! Focus on top Government colleges in your preferred district first."
        elif float(user_cutoff) >= 175:
            strategy_alert = f"Your cutoff of {user_cutoff} gives you solid options across Government and Aided colleges. Consider a mix of safe + aspirational choices."
        elif float(user_cutoff) >= 150:
            strategy_alert = f"With {user_cutoff}, aim for aided and self-financing colleges in your core branch. Widen your district scope for better picks."

    return {
        "answer": full_response,
        "sources": citations,
        "strategy_alert": strategy_alert
    }
def get_or_create_college(college_code: str, db: Session) -> Optional[College]:
    # Normalize college code to 4-digit string
    code_str = str(college_code).strip().zfill(4)
    
    college = db.query(College).filter(College.college_code == code_str).first()
    if college:
        return college
        
    # Fallback search by code as an integer
    try:
        code_int = int(college_code)
        college = db.query(College).filter(College.college_code == str(code_int).zfill(4)).first()
        if college:
            return college
    except ValueError:
        pass

    # Fallback to check if it exists in Cutoffs database, and if so, dynamically heal/create master record
    try:
        code_val = int(code_str)
    except ValueError:
        code_val = None
        
    cutoff_record = None
    if code_val is not None:
        cutoff_record = db.query(CollegeCutoff).filter(
            (CollegeCutoff.college_code == code_val) | 
            (CollegeCutoff.college_code == code_str)
        ).filter(CollegeCutoff.branch_name.isnot(None)).first()
    else:
        cutoff_record = db.query(CollegeCutoff).filter(
            CollegeCutoff.college_code == code_str
        ).filter(CollegeCutoff.branch_name.isnot(None)).first()
        
    if cutoff_record:
        # Dynamically seed/create master record to prevent 404
        college = College(
            college_code=code_str,
            college_name=cutoff_record.college_name,
            district=cutoff_record.district,
            autonomous_status=False,
            minority_status=False,
            principal_name="Not Available",
            address="Address details not available in JSON source.",
            taluk="N/A",
            pincode="N/A",
            parse_confidence=0.5
        )
        db.add(college)
        db.commit()
        db.refresh(college)
        
        # Create empty contacts, hostel, transport
        contact = Contact(college_id=college.id, phone="", email="", website="", anti_ragging_phone="")
        hostel = HostelDetails(
            college_id=college.id, 
            boys_hostel_available=False, 
            girls_hostel_available=False,
            mess_bill=0.0,
            room_rent=0.0,
            electricity_charges=0.0,
            caution_deposit=0.0,
            establishment_charges=0.0
        )
        transport = TransportDetails(
            college_id=college.id, 
            facilities_available=False,
            min_transport_charges=0.0,
            max_transport_charges=0.0,
            nearest_railway_station="Not Specified",
            railway_distance_km=0.0
        )
        db.add(contact)
        db.add(hostel)
        db.add(transport)
        
        # Seed courses from CollegeCutoff branch names for complete robust views
        cutoff_branches = db.query(CollegeCutoff.branch_name).filter(
            (CollegeCutoff.college_code == code_val) | 
            (CollegeCutoff.college_code == code_str)
        ).filter(CollegeCutoff.branch_name.isnot(None)).distinct().all()
        
        for (b_name,) in cutoff_branches:
            if not b_name:
                continue
            words = [w for w in b_name.split() if w.isalnum()]
            if len(words) >= 3:
                b_code = "".join([w[0] for w in words])[:4].upper()
            elif len(words) == 2:
                b_code = (words[0][:2] + words[1][:2]).upper()
            else:
                b_code = words[0][:4].upper() if words else "GEN"
                
            course = Course(
                college_id=college.id,
                branch_code=b_code,
                branch_name=b_name,
                approved_intake=60,
                year_started=None,
                accredited=False,
                accredited_valid_upto="-"
            )
            db.add(course)
            
        db.commit()
        db.refresh(college)
        return college
    return None

@app.get("/college/search")
async def search_colleges(
    district: Optional[str] = None,
    branch: Optional[str] = None,
    name: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(College)
    
    if district:
        query = query.filter(College.district.ilike(f"%{district.strip()}%"))
    
    if name:
        query = query.filter(College.college_name.ilike(f"%{name.strip()}%"))
        
    if branch:
        # Join with Course table to search by branch/course name or code
        query = query.join(Course).filter(
            (Course.branch_name.ilike(f"%{branch.strip()}%")) | 
            (Course.branch_code.ilike(f"%{branch.strip()}%"))
        )
        
    colleges = query.distinct().limit(100).all()
    
    results = []
    for c in colleges:
        contact = db.query(Contact).filter(Contact.college_id == c.id).first()
        results.append({
            "college_code": c.college_code,
            "college_name": c.college_name,
            "district": c.district,
            "autonomous_status": c.autonomous_status,
            "website": contact.website if contact else ""
        })
        
    return results

@app.get("/college/{college_code}")
async def get_college_profile(college_code: str, db: Session = Depends(get_db)):
    # Normalize college code to 4-digit string
    code_str = str(college_code).strip().zfill(4)
    
    college = get_or_create_college(code_str, db)
    if not college:
        raise HTTPException(status_code=404, detail="College not found")

    # Fetch related details
    contact = db.query(Contact).filter(Contact.college_id == college.id).first()
    hostel = db.query(HostelDetails).filter(HostelDetails.college_id == college.id).first()
    transport = db.query(TransportDetails).filter(TransportDetails.college_id == college.id).first()
    courses = db.query(Course).filter(Course.college_id == college.id).all()
    
    # Query cutoff trends for this college code
    try:
        code_val = int(code_str)
    except ValueError:
        code_val = code_str

    cutoffs = db.query(CollegeCutoff).filter(
        (CollegeCutoff.college_code == code_val) | 
        (CollegeCutoff.college_code == code_str)
    ).all()

    # Get historical notes from Vector DB
    try:
        rag_docs = vector_db.similarity_search(f"Historical data for college code {code_str}", k=10)
        historical_notes = [d.page_content for d in rag_docs if str(d.metadata.get('college_code')) == str(code_val)]
    except Exception:
        historical_notes = []

    # Map branches cutoff history
    branches_cutoff = {}
    for col in cutoffs:
        b_name = col.branch_name or "General"
        if b_name not in branches_cutoff:
            branches_cutoff[b_name] = {}
        
        cat = col.category
        branches_cutoff[b_name][cat] = {
            "2021": round(col.cutoff_2021, 2) if col.cutoff_2021 else None,
            "2022": round(col.cutoff_2022, 2) if col.cutoff_2022 else None,
            "2023": round(col.cutoff_2023, 2) if col.cutoff_2023 else None,
            "2024": round(col.cutoff_2024, 2) if col.cutoff_2024 else None,
            "2025": round(col.cutoff_2025, 2) if col.cutoff_2025 else None,
        }

    return {
        "id": college.id,
        "code": college.college_code,
        "name": college.college_name,
        "principal_name": college.principal_name,
        "address": college.address,
        "district": college.district,
        "taluk": college.taluk,
        "pincode": college.pincode,
        "autonomous_status": college.autonomous_status,
        "minority_status": college.minority_status,
        "parse_confidence": college.parse_confidence,
        "category_type": "Autonomous" if college.autonomous_status else "Non-Autonomous",
        "contact": {
            "phone": contact.phone if contact else "",
            "email": contact.email if contact else "",
            "website": contact.website if contact else "",
            "anti_ragging_phone": contact.anti_ragging_phone if contact else ""
        },
        "hostel": {
            "boys_hostel_available": hostel.boys_hostel_available if hostel else False,
            "girls_hostel_available": hostel.girls_hostel_available if hostel else False,
            "mess_bill": hostel.mess_bill if hostel else 0.0,
            "room_rent": hostel.room_rent if hostel else 0.0,
            "electricity_charges": hostel.electricity_charges if hostel else 0.0,
            "caution_deposit": hostel.caution_deposit if hostel else 0.0,
            "establishment_charges": hostel.establishment_charges if hostel else 0.0
        },
        "transport": {
            "facilities_available": transport.facilities_available if transport else False,
            "min_transport_charges": transport.min_transport_charges if transport else 0.0,
            "max_transport_charges": transport.max_transport_charges if transport else 0.0,
            "nearest_railway_station": transport.nearest_railway_station if transport else "",
            "railway_distance_km": transport.railway_distance_km if transport else 0.0
        },
        "courses": [
            {
                "branch_code": c.branch_code,
                "branch_name": c.branch_name,
                "approved_intake": c.approved_intake,
                "year_started": c.year_started,
                "accredited": c.accredited,
                "accredited_valid_upto": c.accredited_valid_upto
            } for c in courses
        ],
        "branches": branches_cutoff,
        "historical_trends": historical_notes
    }

@app.get("/college/{college_code}/courses")
async def get_college_courses(college_code: str, db: Session = Depends(get_db)):
    code_str = str(college_code).strip().zfill(4)
    college = get_or_create_college(code_str, db)
    if not college:
        raise HTTPException(status_code=404, detail="College not found")
    courses = db.query(Course).filter(Course.college_id == college.id).all()
    return [
        {
            "branch_code": c.branch_code,
            "branch_name": c.branch_name,
            "approved_intake": c.approved_intake,
            "year_started": c.year_started,
            "accredited": c.accredited,
            "accredited_valid_upto": c.accredited_valid_upto
        } for c in courses
    ]

@app.get("/college/{college_code}/hostel")
async def get_college_hostel(college_code: str, db: Session = Depends(get_db)):
    code_str = str(college_code).strip().zfill(4)
    college = get_or_create_college(code_str, db)
    if not college:
        raise HTTPException(status_code=404, detail="College not found")
    hostel = db.query(HostelDetails).filter(HostelDetails.college_id == college.id).first()
    if not hostel:
        return {"boys_hostel_available": False, "girls_hostel_available": False, "mess_bill": 0, "room_rent": 0, "electricity_charges": 0, "caution_deposit": 0, "establishment_charges": 0}
    return {
        "boys_hostel_available": hostel.boys_hostel_available,
        "girls_hostel_available": hostel.girls_hostel_available,
        "mess_bill": hostel.mess_bill,
        "room_rent": hostel.room_rent,
        "electricity_charges": hostel.electricity_charges,
        "caution_deposit": hostel.caution_deposit,
        "establishment_charges": hostel.establishment_charges
    }

@app.get("/college/{college_code}/transport")
async def get_college_transport(college_code: str, db: Session = Depends(get_db)):
    code_str = str(college_code).strip().zfill(4)
    college = get_or_create_college(code_str, db)
    if not college:
        raise HTTPException(status_code=404, detail="College not found")
    transport = db.query(TransportDetails).filter(TransportDetails.college_id == college.id).first()
    if not transport:
        return {"facilities_available": False, "min_transport_charges": 0, "max_transport_charges": 0, "nearest_railway_station": "", "railway_distance_km": 0}
    return {
        "facilities_available": transport.facilities_available,
        "min_transport_charges": transport.min_transport_charges,
        "max_transport_charges": transport.max_transport_charges,
        "nearest_railway_station": transport.nearest_railway_station,
        "railway_distance_km": transport.railway_distance_km
    }



@app.get("/directory")
async def get_directory(
    response: Response,
    search: Optional[str] = None,
    districts: Optional[List[str]] = Query(None),
    branches: Optional[List[str]] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1),
    db: Session = Depends(get_db)
):
    from sqlalchemy import or_, and_, cast, String, func

    # --- Cache lookup (skip DB entirely for repeated identical requests) ---
    search_norm = (search or "").strip().lower()
    districts_norm = tuple(sorted(d.strip().lower() for d in (districts or []) if d.strip()))
    branches_norm = tuple(sorted(b.strip().lower() for b in (branches or []) if b.strip()))
    cache_key = (search_norm, districts_norm, branches_norm)

    result = _get_directory_cache(cache_key)

    if result is None:
        # --- Full DB query + grouping (only runs on cache miss) ---
        query = db.query(
            CollegeCutoff.college_code,
            CollegeCutoff.college_name,
            CollegeCutoff.district,
            CollegeCutoff.branch_name,
            func.min(func.coalesce(
                CollegeCutoff.cutoff_2025,
                CollegeCutoff.cutoff_2024,
                CollegeCutoff.cutoff_2023,
                CollegeCutoff.cutoff_2022,
                CollegeCutoff.cutoff_2021
            )).label("min_c"),
            func.max(func.coalesce(
                CollegeCutoff.cutoff_2025,
                CollegeCutoff.cutoff_2024,
                CollegeCutoff.cutoff_2023,
                CollegeCutoff.cutoff_2022,
                CollegeCutoff.cutoff_2021
            )).label("max_c")
        ).filter(
            CollegeCutoff.branch_name.isnot(None),
            (CollegeCutoff.cutoff_2025 > 0) |
            (CollegeCutoff.cutoff_2024 > 0) |
            (CollegeCutoff.cutoff_2023 > 0) |
            (CollegeCutoff.cutoff_2022 > 0) |
            (CollegeCutoff.cutoff_2021 > 0)
        )

        if search_norm:
            tokens = search_norm.split()
            if tokens:
                conditions = []
                for token in tokens:
                    token_conds = [
                        CollegeCutoff.college_name.ilike(f"%{token}%"),
                        CollegeCutoff.district.ilike(f"%{token}%"),
                        cast(CollegeCutoff.college_code, String).ilike(f"%{token}%")
                    ]
                    conditions.append(or_(*token_conds))
                query = query.filter(and_(*conditions))

        if districts:
            dist_conditions = []
            for d in districts:
                d_clean = d.strip().replace(".", "")
                if d_clean:
                    dist_conditions.append(func.replace(CollegeCutoff.district, ".", "").ilike(f"%{d_clean}%"))
            if dist_conditions:
                query = query.filter(or_(*dist_conditions))

        if branches:
            branch_conditions = []
            for b in branches:
                b_clean = b.strip().upper().replace(".", "")
                if b_clean:
                    branch_conditions.append(get_branch_filter_condition(b_clean))
            if branch_conditions:
                query = query.filter(or_(*branch_conditions))

        rows = query.group_by(
            CollegeCutoff.college_code,
            CollegeCutoff.branch_name
        ).order_by(CollegeCutoff.college_name).all()

        directory: Dict[str, dict] = {}
        for code_raw, name, district, branch, min_c, max_c in rows:
            if not code_raw:
                continue
            code = str(code_raw).strip().zfill(4)
            if code not in directory:
                directory[code] = {
                    "name": name,
                    "district": district or "Tamil Nadu",
                    "code": code,
                    "branches": {}
                }
            if branch and min_c is not None and max_c is not None:
                directory[code]["branches"][branch] = {"min": min_c, "max": max_c}

        result = []
        for item in directory.values():
            item["branches"] = [
                {"name": b_name, "min": round(b_range["min"], 2), "max": round(b_range["max"], 2)}
                for b_name, b_range in item["branches"].items()
            ]
            result.append(item)

        _set_directory_cache(cache_key, result)

    # --- Pagination (always applied, even from cache) ---
    total_colleges = len(result)
    start_idx = (page - 1) * limit
    paginated = result[start_idx: start_idx + limit]

    # Tell browser to cache for 60 s (reduces even initial duplicate requests)
    response.headers["Cache-Control"] = "public, max-age=60"

    return {
        "total": total_colleges,
        "page": page,
        "limit": limit,
        "pages": (total_colleges + limit - 1) // limit,
        "colleges": paginated
    }


@app.get("/metadata")
async def get_metadata(db: Session = Depends(get_db)):
    # Query all unique non-null districts and branches
    districts = db.query(CollegeCutoff.district).filter(CollegeCutoff.district.isnot(None)).distinct().all()
    branches = db.query(CollegeCutoff.branch_name).filter(CollegeCutoff.branch_name.isnot(None)).distinct().all()
    
    # Sort and clean
    cleaned_districts = sorted(list(set(d[0].strip().upper() for d in districts if d[0])))
    cleaned_branches = sorted(list(set(b[0].strip().upper() for b in branches if b[0])))
    
    return {
        "districts": [d.title() for d in cleaned_districts],
        "branches": [b.title() for b in cleaned_branches]
    }


@app.get("/tfc")
async def get_tfc_centers(db: Session = Depends(get_db)):
    return db.query(TFCCenter).limit(100).all()

@app.post("/choice/add")
async def add_choice(session_id: str, college_data: dict):
    if session_id not in USER_CHOICES:
        USER_CHOICES[session_id] = []
    
    # Avoid duplicates and handle missing keys safely (Type-insensitive comparison)
    new_code = str(college_data.get('code', '0000'))
    new_branch = str(college_data.get('branch', 'General'))
    
    is_duplicate = any(
        str(c.get('code')) == new_code and str(c.get('branch')) == new_branch 
        for c in USER_CHOICES[session_id]
    )
    
    if not is_duplicate:
        college_data.setdefault("notes", "")
        USER_CHOICES[session_id].append(college_data)
    
    return {"status": "success", "count": len(USER_CHOICES[session_id])}

@app.post("/choice/remove")
async def remove_choice(session_id: str, college_data: dict):
    if session_id in USER_CHOICES:
        code = str(college_data.get('code', '0000'))
        branch = str(college_data.get('branch', 'General'))
        USER_CHOICES[session_id] = [
            c for c in USER_CHOICES[session_id]
            if not (str(c.get('code')) == code and str(c.get('branch')) == branch)
        ]
    return {"status": "success", "count": len(USER_CHOICES.get(session_id, []))}

@app.get("/choice/{session_id}")
async def get_choices(session_id: str):
    return USER_CHOICES.get(session_id, [])

@app.post("/choice/clear")
async def clear_choices(session_id: str):
    if session_id in USER_CHOICES:
        USER_CHOICES[session_id] = []
    return {"status": "success", "count": 0}

@app.post("/choice/reorder")
async def reorder_choices(session_id: str, direction: str, index: int):
    if session_id in USER_CHOICES:
        choices = USER_CHOICES[session_id]
        n = len(choices)
        if direction == "up" and 0 < index < n:
            choices[index], choices[index - 1] = choices[index - 1], choices[index]
        elif direction == "down" and 0 <= index < n - 1:
            choices[index], choices[index + 1] = choices[index + 1], choices[index]
    return {"status": "success", "choices": USER_CHOICES.get(session_id, [])}

@app.post("/choice/notes")
async def update_choice_notes(session_id: str, index: int, notes: str):
    if session_id in USER_CHOICES and 0 <= index < len(USER_CHOICES[session_id]):
        USER_CHOICES[session_id][index]["notes"] = notes
    return {"status": "success", "choices": USER_CHOICES.get(session_id, [])}

# --- Cutoff Calculator Endpoints ---
class CutoffCalcRequest(BaseModel):
    maths: float
    physics: float
    chemistry: float
    category: str
    district: str
    preferred_branch: str

class CutoffCalcResponse(BaseModel):
    cutoff: float
    eligibility_tier: str
    recommendation_summary: str
    suggested_branches: List[str]

@app.post("/calculate-cutoff", response_model=CutoffCalcResponse)
async def calculate_cutoff(req: CutoffCalcRequest, db: Session = Depends(get_db)):
    # Standard TNEA Cutoff formula: Maths (out of 100) + Physics/2 (out of 50) + Chemistry/2 (out of 50)
    # This equals (Maths / 2.0) + (Physics / 4.0) + (Chemistry / 4.0) multiplied by 2 to yield a score out of 200.
    cutoff_200 = float(req.maths + (req.physics / 2.0) + (req.chemistry / 2.0))
    cutoff_200 = min(200.0, max(0.0, cutoff_200)) # clamp between 0 and 200
    
    # Query historic cutoff bounds in SQLite to get expected college metrics
    # We join College to filter by district if specified
    query = db.query(CollegeCutoff, College).join(College, College.college_code == CollegeCutoff.college_code)
    
    # Apply category filter
    query = query.filter(CollegeCutoff.category == req.category)
    
    # Apply branch filter if valid
    branch_clean = req.preferred_branch.strip() if req.preferred_branch else ""
    if branch_clean and branch_clean.lower() != "all" and branch_clean.lower() != "any":
        query = query.filter(CollegeCutoff.branch_name.ilike(f"%{branch_clean}%"))
        
    # Apply district filter if valid
    district_clean = req.district.strip() if req.district else ""
    if district_clean and district_clean.lower() != "all" and district_clean.lower() != "any":
        query = query.filter(College.district.ilike(f"%{district_clean}%"))
        
    results = query.all()
    
    safe_count = 0
    mod_count = 0
    dream_count = 0
    
    for cutoff_row, college in results:
        closing = cutoff_row.cutoff_2025
        if not closing:
            closing = cutoff_row.cutoff_2024
        if not closing:
            continue
            
        if cutoff_200 >= closing + 5.0:
            safe_count += 1
        elif cutoff_200 >= closing - 5.0:
            mod_count += 1
        else:
            dream_count += 1
            
    # Classify overall eligibility tier
    if cutoff_200 >= 175.0:
        eligibility_tier = "Safe (Tier-1 Elite)"
    elif cutoff_200 >= 135.0:
        eligibility_tier = "Moderate (Tier-2 Mid)"
    else:
        eligibility_tier = "Dream (Tier-3 Aspirational)"
        
    # Build personalized recommendation summary
    loc_str = f"in **{district_clean}**" if district_clean and district_clean.lower() != "all" else "across Tamil Nadu"
    branch_str = f"**{branch_clean}**" if branch_clean and branch_clean.lower() != "all" else "engineering courses"
    
    if safe_count > 0 or mod_count > 0:
        summary = (
            f"Based on your calculated TNEA Cutoff of **{cutoff_200:.2f}/200** and category **{req.category}**, "
            f"we identified **{safe_count} Safe** backups and **{mod_count} Moderate** college programs offering {branch_str} {loc_str}. "
            f"You have a highly secure foundation for counselling!"
        )
    else:
        summary = (
            f"Your calculated TNEA Cutoff is **{cutoff_200:.2f}/200** under category **{req.category}**. "
            f"Historic cutoff data indicates that {branch_str} {loc_str} is extremely competitive. "
            f"We recommend expanding your preferred branches or districts in the College Finder to see more matches."
        )
        
    # Suitability branches suggestion based on selection
    suggested = ["Computer Science", "Information Technology", "AI & Data Science", "Electronics & Communication"]
    if branch_clean:
        b_lower = branch_clean.lower()
        if "mech" in b_lower or "civil" in b_lower:
            suggested = ["Mechanical Engineering", "Civil Engineering", "Robotics & Automation", "Electrical & Electronics"]
        elif "elect" in b_lower or "ece" in b_lower or "eee" in b_lower:
            suggested = ["Electronics & Communication", "Electrical & Electronics", "Instrumentation & Control", "Computer Science"]
            
    return {
        "cutoff": cutoff_200,
        "eligibility_tier": eligibility_tier,
        "recommendation_summary": summary,
        "suggested_branches": suggested
    }

@app.get("/rag_records")
async def get_rag_records(search: Optional[str] = None):
    # Get documents from the specific source we just ingested
    collection = vector_db._collection
    
    # Building query
    query_params = {"where": {"source": "tnea_cutoff_all.json"}}
    if search:
        query_params["limit"] = 100
    else:
        query_params["limit"] = 100 
        
    results = collection.get(**query_params)
    
    documents = results.get('documents', [])
    metadatas = results.get('metadatas', [])
    
    records = []
    for doc, meta in zip(documents, metadatas):
        # Extract college name from doc content
        import re
        match = re.search(r"College: (.*?) \(Code:", doc)
        college_name = match.group(1) if match else "Unknown"
        
        branch_match = re.search(r"Branch: (.*?) \(", doc)
        branch_name = branch_match.group(1) if branch_match else "Unknown"
        
        records.append({
            "code": meta.get('college_code') or "0000",
            "name": college_name or "Unknown College",
            "branch": branch_name or "General",
            "district": meta.get('district') or "Unknown",
            "content": doc
        })
        
    return {
        "count": collection.count(),
        "records": records
    }

@app.get("/health")
async def health(): return {"status": "ok"}

# Serve Frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
