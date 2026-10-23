# FraudShield model service (Flask + XGBoost). Every container start retrains the model from
# scratch on /app/data/case_01_labelled_transactions_*.csv (see entrypoint.sh), then serves it.
FROM python:3.13.1-slim
WORKDIR /app
COPY ml/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY ml/ /app/ml/
WORKDIR /app/ml
ENV PYTHONUNBUFFERED=1 PORT=5000
EXPOSE 5000
HEALTHCHECK --interval=5s --timeout=3s --start-period=300s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/health').status==200 else 1)"
CMD ["sh", "/app/ml/entrypoint.sh"]
