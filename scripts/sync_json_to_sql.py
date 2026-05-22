import json
import os
from backend.app.database import SessionLocal, College, engine, Base

# Configuration
JSON_PATH = "backend/data/docs/tnea_cutoff_all.json"

def sync_data():
    print(f"Loading JSON data from {JSON_PATH}...")
    if not os.path.exists(JSON_PATH):
        print(f"Error: {JSON_PATH} not found.")
        return

    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    compare_section = data.get("datasets", {}).get("compare", {})
    cutoff_data = compare_section.get("cutoff", {}).get("data", [])
    
    db = SessionLocal()
    
    print(f"Syncing {len(cutoff_data)} records to SQL...")
    
    count = 0
    for item in cutoff_data:
        college_code = item["college_code"]
        college_name = item["college_name"]
        branch_name = item["branch_name"]
        district = item["district"]
        values = item["values"]
        
        year_map = {
            "2021": "cutoff_2021",
            "2022": "cutoff_2022",
            "2023": "cutoff_2023",
            "2024": "cutoff_2024",
            "2025": "cutoff_2025"
        }
        
        # Get all categories from all years
        all_categories = set()
        for year in year_map.keys():
            all_categories.update(values.get(year, {}).keys())
            
        for category in all_categories:
            if not category: continue
            
            # Check if record exists
            existing = db.query(College).filter(
                College.college_code == college_code,
                College.branch_name == branch_name,
                College.category == category.upper()
            ).first()
            
            if not existing:
                existing = College(
                    college_code=college_code,
                    college_name=college_name,
                    branch_name=branch_name,
                    district=district,
                    category=category.upper()
                )
                db.add(existing)
            
            # Populate year-wise cutoffs
            for year, column in year_map.items():
                cutoff_val = values.get(year, {}).get(category)
                if cutoff_val is not None:
                    setattr(existing, column, float(cutoff_val))
            
            count += 1
            if count % 1000 == 0:
                db.commit()
                print(f"Synced {count} records...")

    db.commit()
    print(f"SUCCESS: Synced {count} records from JSON to SQL Database.")
    db.close()

if __name__ == "__main__":
    sync_data()
