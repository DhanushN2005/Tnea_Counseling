from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
import torch
import os
import re

# Configuration
CHROMA_PATH = "backend/data/db/chroma_db"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
COLLECTION_NAME = "tnea_docs"

def list_records():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL, 
        model_kwargs={'device': device}
    )
    
    if not os.path.exists(CHROMA_PATH):
        print(f"Error: ChromaDB not found.")
        return

    vector_db = Chroma(
        persist_directory=CHROMA_PATH, 
        embedding_function=embeddings, 
        collection_name=COLLECTION_NAME
    )
    
    # Get documents from the JSON source
    collection = vector_db._collection
    results = collection.get(
        where={"source": "tnea_cutoff_all.json"}
    )
    
    documents = results.get('documents', [])
    metadatas = results.get('metadatas', [])
    
    print("\n--- INGESTED TNEA RECORDS (FROM CHROMADB) ---")
    
    for doc, meta in zip(documents, metadatas):
        # Extract college name from doc content
        # Format: "College: <Name> (Code: <Code>)"
        match = re.search(r"College: (.*?) \(Code:", doc)
        college_name = match.group(1) if match else "Unknown"
        
        # Extract branch name
        # Format: "Branch: <Name> (<Code>)"
        branch_match = re.search(r"Branch: (.*?) \(", doc)
        branch_name = branch_match.group(1) if branch_match else "Unknown"
        
        code = meta.get('college_code', 'N/A')
        branch_code = meta.get('branch_code', 'N/A')
        district = meta.get('district', 'N/A')
        
        print(f"CODE: {code:4} | NAME: {college_name[:40]:40} | COURSE: {branch_name[:30]:30} | DIST: {district}")

if __name__ == "__main__":
    list_records()
