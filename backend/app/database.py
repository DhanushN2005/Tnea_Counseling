from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

SQLALCHEMY_DATABASE_URL = "sqlite:///./backend/data/db/tnea_structured.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class CollegeCutoff(Base):
    __tablename__ = "college_cutoffs"

    id = Column(Integer, primary_key=True, index=True)
    college_code = Column(Integer, index=True)
    college_name = Column(String)
    district = Column(String)
    category = Column(String) # Government, Aided, Self-Financing, etc.
    branch_name = Column(String, nullable=True)
    cutoff_2021 = Column(Float, nullable=True)
    cutoff_2022 = Column(Float, nullable=True)
    cutoff_2023 = Column(Float, nullable=True)
    cutoff_2024 = Column(Float, nullable=True)
    cutoff_2025 = Column(Float, nullable=True)

class College(Base):
    __tablename__ = "colleges"

    id = Column(Integer, primary_key=True, index=True)
    college_code = Column(String, unique=True, index=True)
    college_name = Column(String, index=True)
    principal_name = Column(String, nullable=True)
    address = Column(String, nullable=True)
    district = Column(String, nullable=True)
    taluk = Column(String, nullable=True)
    pincode = Column(String, nullable=True)
    autonomous_status = Column(Boolean, default=False)
    minority_status = Column(Boolean, default=False)
    parse_confidence = Column(Float, default=1.0)

class Contact(Base):
    __tablename__ = "contacts"

    college_id = Column(Integer, ForeignKey("colleges.id"), primary_key=True)
    phone = Column(String, nullable=True)
    email = Column(String, nullable=True)
    website = Column(String, nullable=True)
    anti_ragging_phone = Column(String, nullable=True)

class Course(Base):
    __tablename__ = "courses"

    id = Column(Integer, primary_key=True, index=True)
    college_id = Column(Integer, ForeignKey("colleges.id"), index=True)
    branch_code = Column(String, index=True)
    branch_name = Column(String)
    approved_intake = Column(Integer, nullable=True)
    year_started = Column(Integer, nullable=True)
    accredited = Column(Boolean, default=False)
    accredited_valid_upto = Column(String, nullable=True)

class HostelDetails(Base):
    __tablename__ = "hostel_details"

    college_id = Column(Integer, ForeignKey("colleges.id"), primary_key=True)
    boys_hostel_available = Column(Boolean, default=False)
    girls_hostel_available = Column(Boolean, default=False)
    mess_bill = Column(Float, default=0.0)
    room_rent = Column(Float, default=0.0)
    electricity_charges = Column(Float, default=0.0)
    caution_deposit = Column(Float, default=0.0)
    establishment_charges = Column(Float, default=0.0)

class TransportDetails(Base):
    __tablename__ = "transport_details"

    college_id = Column(Integer, ForeignKey("colleges.id"), primary_key=True)
    facilities_available = Column(Boolean, default=False)
    min_transport_charges = Column(Float, default=0.0)
    max_transport_charges = Column(Float, default=0.0)
    nearest_railway_station = Column(String, nullable=True)
    railway_distance_km = Column(Float, nullable=True)

class TFCCenter(Base):
    __tablename__ = "tfc_centers"

    id = Column(Integer, primary_key=True, index=True)
    tfc_number = Column(Integer)
    district = Column(String)
    name_address = Column(String)
    coordinator = Column(String)
    contact = Column(String)

Base.metadata.create_all(bind=engine)

