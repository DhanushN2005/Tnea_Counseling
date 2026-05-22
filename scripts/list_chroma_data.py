from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
import torch
import os

# Configuration
CHROMA_PATH = "backend/data/db/chroma_db"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
COLLECTION_NAME = "tnea_docs"

def list_data(limit=50):
    print(f"--- LISTING FIRST {limit} DOCUMENTS FROM CHROMADB ---")
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL, 
        model_kwargs={'device': device}
    )
    
    if not os.path.exists(CHROMA_PATH):
        print(f"Error: ChromaDB not found at {CHROMA_PATH}")
        return

    vector_db = Chroma(
        persist_directory=CHROMA_PATH, 
        embedding_function=embeddings, 
        collection_name=COLLECTION_NAME
    )
    
    # Get documents from the specific source we just ingested
    collection = vector_db._collection
    results = collection.get(
        where={"source": "tnea_cutoff_all.json"},
        limit=limit
    )
    
    documents = results.get('documents', [])
    metadatas = results.get('metadatas', [])
    
    print(f"Total documents in collection: {collection.count()}")
    print(f"Documents from 'tnea_cutoff_all.json': {len(documents)}")
    print("-" * 50)
    
    for i, (doc, meta) in enumerate(zip(documents, metadatas)):
        print(f"DOCUMENT {i+1}:")
        print(f"Metadata: {meta}")
        print(f"Content:\n{doc}")
        print("-" * 30)

if __name__ == "__main__":
    list_data()
