from backend.app.database import SessionLocal, College, Base, engine
import random

# Recreate tables
Base.metadata.drop_all(bind=engine)
Base.metadata.create_all(bind=engine)

colleges_data = [
    (1, "College of Engineering, Guindy", "CS", "Computer Science and Engineering", "Chennai", 199.5),
    (1, "College of Engineering, Guindy", "IT", "Information Technology", "Chennai", 198.5),
    (2, "PSG College of Technology", "CS", "Computer Science and Engineering", "Coimbatore", 198.0),
    (2, "PSG College of Technology", "EC", "Electronics and Communication", "Coimbatore", 197.0),
    (4, "Madras Institute of Technology", "AE", "Aeronautical Engineering", "Chennai", 196.5),
    (4, "Madras Institute of Technology", "CS", "Computer Science and Engineering", "Chennai", 197.5),
    (2006, "PSG Institute of Technology and Applied Research", "CS", "Computer Science and Engineering", "Coimbatore", 195.0),
    (1315, "Sri Krishna College of Engineering and Technology", "CS", "Computer Science and Engineering", "Coimbatore", 192.5),
    (1219, "Sri Sivasubramaniya Nadar College of Engineering", "CS", "Computer Science and Engineering", "Chennai", 196.0),
    (2711, "Kongu Engineering College", "CS", "Computer Science and Engineering", "Erode", 188.0),
    (2712, "Kumaraguru College of Technology", "CS", "Computer Science and Engineering", "Coimbatore", 191.0),
    (1419, "Sri Venkateswara College of Engineering", "CS", "Computer Science and Engineering", "Kancheepuram", 190.5),
    (4960, "Mepco Schlenk Engineering College", "CS", "Computer Science and Engineering", "Virudhunagar", 187.0),
    (2718, "Sona College of Technology", "CS", "Computer Science and Engineering", "Salem", 182.0),
    (1399, "Chennai Institute of Technology", "CS", "Computer Science and Engineering", "Chennai", 193.0),
]

categories = ["OC", "BC", "BCM", "MBC", "SC", "SCA", "ST"]

db = SessionLocal()

for code, name, b_code, b_name, district, base_cutoff in colleges_data:
    for cat in categories:
        # Simulate category-wise cutoff drops
        cat_cutoff = base_cutoff - (categories.index(cat) * 2.5)
        college = College(
            college_code=code,
            college_name=name,
            branch_code=b_code,
            branch_name=b_name,
            district=district,
            category=cat,
            cutoff_2023=cat_cutoff,
            cutoff_2022=cat_cutoff + 1.0,
            seat_type="Surrender"
        )
        db.add(college)

db.commit()
db.close()
print("Database seeded with sample TNEA data.")
