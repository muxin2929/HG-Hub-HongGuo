FROM python:3.12-slim

WORKDIR /app
COPY . .

# 可选但强烈建议：装了 cryptography 就用 C 实现解封面（快 1000 倍）；
# 没装也能跑（内置纯 Python AES 兜底）。
RUN pip install --no-cache-dir cryptography || true

ENV HOST=0.0.0.0 PORT=8080 CACHE_DIR=/cache
EXPOSE 8080
CMD ["python", "app.py"]
