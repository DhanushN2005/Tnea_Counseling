import json
import os
import torch
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_chroma import Chroma
from langchain_core.documents import Document

# --- Configuration ---
device = "cuda" if torch.cuda.is_available() else "cpu"
CHROMA_PATH = "backend/data/db/chroma_db"
JSON_PATH = "backend/data/docs/tnea_cutoff_all.json"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

embeddings = HuggingFaceEmbeddings(
    model_name=EMBEDDING_MODEL, 
    model_kwargs={'device': device}
)

def format_cutoff_data(data):
    """Formats the JSON structure into a searchable text document."""
    docs = []
    
    # Process Cutoff Marks
    compare_section = data.get("datasets", {}).get("compare", {})
    cutoff_data = compare_section.get("cutoff", {}).get("data", [])
    # Process Rank Data
    rank_data = compare_section.get("rank", {}).get("data", [])
    
    # Map rank data by (college_code, branch_code) for easy lookup
    rank_map = {}
    for item in rank_data:
        key = (item["college_code"], item["branch_code"])
        rank_map[key] = item["values"]
    
    for item in cutoff_data:
        college_name = item["college_name"]
        college_code = item["college_code"]
        branch_name = item["branch_name"]
        branch_code = item["branch_code"]
        district = item["district"]
        college_type = item["college_type"]
        
        content = f"College: {college_name} (Code: {college_code})\n"
        content += f"Branch: {branch_name} ({branch_code})\n"
        content += f"Location: {district}, Type: {college_type}\n\n"
        
        content += "Historical Cutoff Marks and Ranks:\n"
        
        cutoff_values = item["values"]
        key = (college_code, branch_code)
        ranks_values = rank_map.get(key, {})
        
        # Get all years available
        years = sorted(set(list(cutoff_values.keys()) + list(ranks_values.keys())), reverse=True)
        
        for year in years:
            year_cutoff = cutoff_values.get(year, {})
            year_rank = ranks_values.get(year, {})
            
            content += f"Year {year}:\n"
            categories = sorted(set(list(year_cutoff.keys()) + list(year_rank.keys())))
            for cat in categories:
                mark = year_cutoff.get(cat)
                rank = year_rank.get(cat)
                if mark or rank:
                    content += f"  - {cat.upper()}: Cutoff {mark if mark else 'N/A'}, Rank {rank if rank else 'N/A'}\n"
            content += "\n"
            
        docs.append(Document(
            page_content=content.strip(),
            metadata={
                "source": "tnea_cutoff_all.json",
                "college_code": college_code,
                "branch_code": branch_code,
                "topic": "cutoff",
                "district": district
            }
        ))
        
    return docs

def ingest_json():
    print(f"Loading JSON data from {JSON_PATH}...")
    if not os.path.exists(JSON_PATH):
        print(f"Error: {JSON_PATH} not found.")
        return

    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    print("Formatting data into documents...")
    documents = format_cutoff_data(data)
    print(f"Created {len(documents)} documents.")

    print(f"Adding to ChromaDB at {CHROMA_PATH}...")
    vector_db = Chroma(
        persist_directory=CHROMA_PATH,
        embedding_function=embeddings,
        collection_name="tnea_docs"
    )
    
    # Batch add to avoid memory issues with large number of docs
    batch_size = 500
    for i in range(0, len(documents), batch_size):
        batch = documents[i:i + batch_size]
        # Generate IDs to prevent duplicates
        batch_ids = [f"{doc.metadata['college_code']}_{doc.metadata['branch_code']}" for doc in batch]
        vector_db.add_documents(batch, ids=batch_ids)
        print(f"Ingested {i + len(batch)} / {len(documents)}...")

    print("SUCCESS: TNEA Cutoff and Rank data fed into RAG.")

if __name__ == "__main__":
    ingest_json()
