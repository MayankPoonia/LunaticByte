# FraudShield model service (Flask + XGBoost). Built from the repository root so the synthetic
# data generator is available when no data pack is mounted.
FROM python:3.13.1-slim
WORKDIR /app
COPY ml/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY scripts/ /app/scripts/
COPY ml/ /app/ml/
WORKDIR /app/ml
ENV PYTHONUNBUFFERED=1 PORT=5000
EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=10 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/health').status==200 else 1)"
CMD ["sh", "/app/ml/entrypoint.sh"]
