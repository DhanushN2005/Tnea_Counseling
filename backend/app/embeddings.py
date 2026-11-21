"""Lightweight query embeddings: all-MiniLM-L6-v2 via ONNX Runtime (no PyTorch).

Produces the same 384-dim normalized vectors as the sentence-transformers model
that built the existing ChromaDB store, so no re-ingestion is needed.
The ONNX model (~80MB) is cached under ~/.cache/chroma/onnx_models and is
downloaded on first use (pre-download it at image build time for deployment).
"""
from typing import List

from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
from langchain_core.embeddings import Embeddings


class OnnxMiniLMEmbeddings(Embeddings):
    def __init__(self):
        self._fn = ONNXMiniLM_L6_V2()
        # Load/download the model at startup so the first user request isn't slow
        # (on hosts like Render the build-time download is not kept for runtime).
        self._fn(["warmup"])

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return [[float(x) for x in v] for v in self._fn(list(texts))]

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]
