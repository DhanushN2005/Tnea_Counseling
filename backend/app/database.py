from sqlalchemy import create_engine, Column, Integer, String, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

SQLALCHEMY_DATABASE_URL = "sqlite:///./backend/data/db/tnea_structured.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class College(Base):
    __tablename__ = "colleges"

    id = Column(Integer, primary_key=True, index=True)
    college_code = Column(Integer, index=True)
    college_name = Column(String)
    district = Column(String)
    category = Column(String) # Government, Aided, Self-Financing
    branch_name = Column(String, nullable=True)
    cutoff_2021 = Column(Float, nullable=True)
    cutoff_2022 = Column(Float, nullable=True)
    cutoff_2023 = Column(Float, nullable=True)
    cutoff_2024 = Column(Float, nullable=True)
    cutoff_2025 = Column(Float, nullable=True)

class TFCCenter(Base):
    __tablename__ = "tfc_centers"

    id = Column(Integer, primary_key=True, index=True)
    tfc_number = Column(Integer)
    district = Column(String)
    name_address = Column(String)
    coordinator = Column(String)
    contact = Column(String)

Base.metadata.create_all(bind=engine)
