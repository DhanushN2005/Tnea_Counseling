import os
import re
import pandas as pd
import pdfplumber
import fitz  # PyMuPDF
import torch
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_chroma import Chroma
import pytesseract
import sys
# Ensure the project root is in the python path for absolute imports
sys.path.append(os.getcwd())
from backend.app.database import SessionLocal, College, TFCCenter

# --- Configuration ---
tesseract_path = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
if os.path.exists(tesseract_path):
    pytesseract.pytesseract.tesseract_cmd = tesseract_path

# Force CPU for ingestion to keep GPU memory free for the LLM
device = "cpu"
CHROMA_PATH = "backend/data/db/chroma_db"
DOCS_PATH = "backend/data/docs"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

embeddings = HuggingFaceEmbeddings(
    model_name=EMBEDDING_MODEL, 
    model_kwargs={'device': device}
)

def get_topic_from_text(text):
    text = text.lower()
    if any(k in text for k in ["eligible", "age", "marks", "qualification"]): return "eligibility"
    if any(k in text for k in ["fee", "cost", "payment", "tuition"]): return "fees"
    if any(k in text for k in ["scholarship", "first graduate", "fg", "waive"]): return "scholarship"
    if any(k in text for k in ["reservation", "bc", "mbc", "sc", "st", "community"]): return "reservation"
    if any(k in text for k in ["counselling", "choice", "payment", "stages"]): return "process"
    if any(k in text for k in ["career", "scope", "job", "salary", "placement"]): return "career"
    return "general"

def clean_text(text):
    text = re.sub(r'Page \d+ of \d+', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def process_pdf_with_ocr(file_path):
    doc = fitz.open(file_path)
    final_docs = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text()
        if len(text.strip()) < 50:
            try:
                pix = page.get_pixmap()
                img_data = pix.tobytes("png")
                from PIL import Image
                import io
                img = Image.open(io.BytesIO(img_data))
                text = pytesseract.image_to_string(img)
            except:
                text = "[Image Content Not Readable]"
        
        from langchain_core.documents import Document
        topic = get_topic_from_text(text)
        final_docs.append(Document(
            page_content=clean_text(text),
            metadata={
                "source": os.path.basename(file_path),
                "page": page_num + 1,
                "topic": topic,
                "year": 2026
            }
        ))
    doc.close()
    return final_docs

def extract_tfc_data(file_path):
    print(f"Parsing TFC Centers table...")
    db = SessionLocal()
    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                table = page.extract_table()
                if table:
                    for row in table[1:]:
                        if len(row) >= 4:
                            tfc = TFCCenter(
                                tfc_number=int(row[2]) if str(row[2]).isdigit() else 0,
                                district=row[1],
                                name_address=row[3],
                                coordinator=row[4] if len(row) > 4 else "",
                                contact=row[5] if len(row) > 5 else ""
                            )
                            db.add(tfc)
        db.commit()
    except Exception as e: print(f"❌ TFC Error: {e}")
    finally: db.close()

def extract_college_list(file_path):
    print(f"Parsing College List table...")
    db = SessionLocal()
    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                table = page.extract_table()
                if table:
                    for row in table[1:]:
                        if len(row) >= 3 and str(row[0]).isdigit():
                            college = College(
                                college_code=int(row[0]),
                                college_name=row[1],
                                district=row[2],
                                category="General"
                            )
                            db.add(college)
        db.commit()
    except Exception as e: print(f"❌ College Error: {e}")
    finally: db.close()

def ingest_documents():
    # Safely clear the vector DB using the API instead of deleting the folder
    # This prevents PermissionErrors if the app is running
    print("Clearing old AI memory for a fresh sync...")
    try:
        import chromadb
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        # Try to get the collection and wipe it
        try:
            coll = client.get_collection("tnea_docs")
            coll.delete(where={})
            print("--- Collection wiped successfully ---")
        except:
            print("--- Collection not found, creating new one ---")
    except Exception as e:
        print(f"--- Warning: Could not clear DB via API: {e} ---")

    if not os.path.exists(CHROMA_PATH): os.makedirs(CHROMA_PATH)
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=600, chunk_overlap=120)
    all_chunks = []
    
    for filename in os.listdir(DOCS_PATH):
        file_path = os.path.join(DOCS_PATH, filename)
        is_tabular = False
        
        if "tfc" in filename.lower() and filename.endswith(".pdf"):
            extract_tfc_data(file_path)
            is_tabular = True
        elif "college" in filename.lower() and filename.endswith(".pdf"):
            extract_college_list(file_path)
            is_tabular = True
        
        if not is_tabular:
            docs = []
            if filename.endswith(".pdf"):
                print(f"Indexing with Topics: {filename}")
                docs = process_pdf_with_ocr(file_path)
            elif filename.endswith(".docx"):
                print(f"Indexing DOCX: {filename}")
                loader = Docx2txtLoader(file_path)
                docs = loader.load()
            
            if docs:
                chunks = text_splitter.split_documents(docs)
                for chunk in chunks:
                    chunk.metadata["topic"] = get_topic_from_text(chunk.page_content)
                all_chunks.extend(chunks)

    if all_chunks:
        print(f"Generating Topic-Filtered Embeddings for {len(all_chunks)} chunks on {device.upper()}...")
        vector_db = Chroma.from_documents(
            documents=all_chunks,
            embedding=embeddings,
            persist_directory=CHROMA_PATH,
            collection_name="tnea_docs"
        )
        print("ADVANCED INGESTION COMPLETE.")
    else: print("SQL TABLES UPDATED.")

if __name__ == "__main__":
    ingest_documents()
