import os
import subprocess
import sys

def run_script(script_path):
    print(f"--- Running {script_path} ---")
    env = os.environ.copy()
    env["PYTHONPATH"] = "."
    result = subprocess.run([sys.executable, script_path], env=env)
    if result.returncode == 0:
        print(f"--- SUCCESS: {script_path} ---")
    else:
        print(f"--- FAILED: {script_path} (Exit code: {result.returncode}) ---")
    return result.returncode == 0

def main():
    # 1. Sync JSON to SQL (Fast)
    run_script("scripts/sync_json_to_sql.py")
    
    # 2. Ingest Documents (PDFs) to Vector & SQL (Wipes Vector collection)
    run_script("scripts/ingest_docs.py")
    
    # 3. Ingest JSON to Vector (Adds JSON data back to Vector)
    run_script("scripts/ingest_json_cutoff.py")
    
    print("\n--- MASTER SYNC COMPLETE ---")

if __name__ == "__main__":
    main()
