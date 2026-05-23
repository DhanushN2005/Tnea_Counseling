import json
import os
import sqlite3
import logging
import sys

# Add root folder to python path so we can import backend packages
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.app.database import (
    SessionLocal, College, Contact, Course, 
    HostelDetails, TransportDetails, engine, Base
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

DB_PATH = "./backend/data/db/tnea_structured.db"
JSON_PATH = "./backend/data/docs/colleges.json"

def run_migration():
    logger.info("Checking database tables for required migration...")
    if not os.path.exists(DB_PATH):
        logger.info("Database file not found at %s. It will be created when we initialize models.", DB_PATH)
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        # Check if 'colleges' table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='colleges'")
        colleges_exists = cursor.fetchone() is not None

        if colleges_exists:
            # Check if the 'colleges' table is indeed the old cutoff one (has category or cutoff_2025 column)
            cursor.execute("PRAGMA table_info(colleges)")
            columns = [col[1] for col in cursor.fetchall()]
            if "cutoff_2025" in columns or "category" in columns:
                logger.info("Found old 'colleges' table with cutoff history. Performing migration...")
                logger.info("Dropping empty 'college_cutoffs' table to clear path for rename...")
                cursor.execute("DROP TABLE IF EXISTS college_cutoffs")
                logger.info("Renaming old 'colleges' to 'college_cutoffs'...")
                cursor.execute("ALTER TABLE colleges RENAME TO college_cutoffs")
                conn.commit()
                logger.info("Successfully migrated old colleges table to college_cutoffs.")
            else:
                logger.info("Table 'colleges' has already been migrated to new master schema.")
        else:
            logger.info("No colleges table found yet. Ready for clean database creation.")

        # Check if 'college_cutoffs' exists to clean up conflicting indexes
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='college_cutoffs'")
        cutoffs_exists = cursor.fetchone() is not None
        
        if cutoffs_exists:
            logger.info("Cleaning up conflicting index names on college_cutoffs table...")
            cursor.execute("DROP INDEX IF EXISTS ix_colleges_id")
            cursor.execute("DROP INDEX IF EXISTS ix_colleges_college_code")
            cursor.execute("CREATE INDEX IF NOT EXISTS ix_college_cutoffs_id ON college_cutoffs (id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS ix_college_cutoffs_college_code ON college_cutoffs (college_code)")
            conn.commit()
            logger.info("Successfully cleaned and rebuilt indexes for college_cutoffs.")

    except Exception as e:
        logger.error("Migration error: %s", e)
    finally:
        conn.close()

def import_json():
    logger.info("Opening json file: %s", JSON_PATH)
    if not os.path.exists(JSON_PATH):
        logger.error("JSON file not found at %s", JSON_PATH)
        return

    with open(JSON_PATH, "r", encoding="utf-8") as f:
        colleges_data = json.load(f)

    logger.info("Found %d college records in JSON. Importing...", len(colleges_data))

    # Initialize new tables
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        imported_count = 0
        skipped_count = 0
        for data in colleges_data:
            code = data.get("college_code")
            if not code:
                logger.warning("Skipping record with missing college_code: %s", data.get("college_name", "Unknown"))
                skipped_count += 1
                continue

            # Clean and keep leading zeros in college code
            code_str = str(code).strip().zfill(4)

            # Avoid duplicates
            existing = db.query(College).filter(College.college_code == code_str).first()
            if existing:
                skipped_count += 1
                continue

            # Create College entry
            college = College(
                college_code=code_str,
                college_name=data.get("college_name"),
                principal_name=data.get("principal_name"),
                address=data.get("address"),
                district=data.get("district"),
                taluk=data.get("taluk"),
                pincode=data.get("pincode"),
                autonomous_status=bool(data.get("autonomous_status", False)),
                minority_status=bool(data.get("minority_status", False)),
                parse_confidence=float(data.get("parse_confidence", 1.0))
            )
            db.add(college)
            db.flush() # Populate the ID

            # Create Contact details
            contact_data = data.get("contact") or {}
            contact = Contact(
                college_id=college.id,
                phone=contact_data.get("phone"),
                email=contact_data.get("email"),
                website=contact_data.get("website"),
                anti_ragging_phone=contact_data.get("anti_ragging_phone")
            )
            db.add(contact)

            # Create Courses
            courses_data = data.get("courses") or []
            for course_item in courses_data:
                course = Course(
                    college_id=college.id,
                    branch_code=course_item.get("branch_code"),
                    branch_name=course_item.get("branch_name"),
                    approved_intake=course_item.get("approved_intake"),
                    year_started=course_item.get("year_started"),
                    accredited=bool(course_item.get("accredited", False)),
                    accredited_valid_upto=str(course_item.get("accredited_valid_upto", "-"))
                )
                db.add(course)

            # Create Hostel details
            hostel_data = data.get("hostel") or {}
            boys_data = hostel_data.get("boys_hostel") or {}
            girls_data = hostel_data.get("girls_hostel") or {}
            
            # Helper to check if available
            boys_avail = bool(boys_data.get("accommodation_available", False)) if boys_data else False
            girls_avail = bool(girls_data.get("accommodation_available", False)) if girls_data else False
            
            # Helper to resolve charges
            def get_fee(key, default=0.0):
                val = None
                if boys_data:
                    val = boys_data.get(key)
                if val is None and girls_data:
                    val = girls_data.get(key)
                return float(val) if val is not None else default

            hostel = HostelDetails(
                college_id=college.id,
                boys_hostel_available=boys_avail,
                girls_hostel_available=girls_avail,
                mess_bill=get_fee("mess_bill"),
                room_rent=get_fee("room_rent"),
                electricity_charges=get_fee("electricity_charges"),
                caution_deposit=float(hostel_data.get("caution_deposit") or 0.0),
                establishment_charges=float(hostel_data.get("establishment_charges") or 0.0)
            )
            db.add(hostel)

            # Create Transport details
            transport_data = data.get("transport") or {}
            bank_data = data.get("bank_details") or {}
            
            # Mapped near railway station details from bank_details inside transport details
            transport = TransportDetails(
                college_id=college.id,
                facilities_available=bool(transport_data.get("facilities_available", False)),
                min_transport_charges=float(transport_data.get("min_transport_charges") or 0.0) if transport_data.get("min_transport_charges") is not None else 0.0,
                max_transport_charges=float(transport_data.get("max_transport_charges") or 0.0) if transport_data.get("max_transport_charges") is not None else 0.0,
                nearest_railway_station=bank_data.get("nearest_railway_station"),
                railway_distance_km=float(bank_data.get("railway_distance_km") or 0.0) if bank_data.get("railway_distance_km") is not None else 0.0
            )
            db.add(transport)

            imported_count += 1
            if imported_count % 50 == 0:
                db.commit()
                logger.info("Successfully imported %d colleges...", imported_count)

        db.commit()
        logger.info("Import completed successfully! Total imported: %d colleges, skipped: %d.", imported_count, skipped_count)
    except Exception as e:
        db.rollback()
        logger.error("Error during import: %s", str(e), exc_info=True)
    finally:
        db.close()

if __name__ == "__main__":
    run_migration()
    import_json()
