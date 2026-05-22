from backend.app.database import SessionLocal, College, TFCCenter
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
import torch

# Configuration
CHROMA_PATH = "backend/data/db/chroma_db"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

def verify():
    print("--- TNEA SYSTEM VERIFICATION ---")
    
    # 1. Check SQL Database
    db = SessionLocal()
    college_count = db.query(College).count()
    tfc_count = db.query(TFCCenter).count()
    
    print(f"\n[SQL Database]")
    print(f"Total Colleges: {college_count}")
    print(f"Total TFC Centers: {tfc_count}")
    
    if college_count > 0:
        sample = db.query(College).first()
        print(f"   Sample College: {sample.college_name} ({sample.district})")
    
    if tfc_count > 0:
        sample_tfc = db.query(TFCCenter).first()
        print(f"   Sample TFC: {sample_tfc.name_address[:50]}...")

    # 2. Check Vector DB
    print(f"\n[Vector Database (ChromaDB)]")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL, 
        model_kwargs={'device': device, 'local_files_only': True}
    )
    
    try:
        vector_db = Chroma(persist_directory=CHROMA_PATH, embedding_function=embeddings, collection_name="tnea_docs")
        # Get count of documents in the collection
        collection = vector_db._collection
        count = collection.count()
        print(f"AI Knowledge Chunks: {count}")
        print(f"Running on: {device.upper()}")
    except Exception as e:
        print(f"Error accessing ChromaDB: {e}")

    print("\nSUCCESS: Everything looks good! You can now start chatting.")
    db.close()

if __name__ == "__main__":
    verify()
