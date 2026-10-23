"""
Generate a SYNTHETIC stand-in data pack in ./devdata with the same file names
and column layouts as the official case-study data pack.

Purpose: lets the application, tests and ML pipeline run before the official
files are copied into ./data. Nothing produced here is real; metrics computed
on it say nothing about the official dataset.

Cards C1001-C1010 and batch rows T200000001-T200000010 reproduce the worked
examples 1-10 of the case study, so the expected values in the sample batch
come straight from the case-study document.

Usage:  python3 scripts/generate_synthetic_data.py [output_dir]
"""
import csv
import json
import math
import os
import random
import sys
from datetime import date, datetime, timedelta, timezone

import numpy as np

IST = timezone(timedelta(hours=5, minutes=30))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "devdata")
os.makedirs(OUT, exist_ok=True)
rng = random.Random(42)
np_rng = np.random.default_rng(42)

V = "V1.0"


def write_csv(name, header, rows):
    with open(os.path.join(OUT, f"case_01_{name}_{V}.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def ts(dt):
    return dt.astimezone(IST).isoformat(timespec="seconds")


# ---------------------------------------------------------------- reference data
CITIES = [
    ("Mumbai", "IN", 19.0760, 72.8777, "METRO"),
    ("Delhi", "IN", 28.6139, 77.2090, "METRO"),
    ("Pune", "IN", 18.5204, 73.8567, "METRO"),
    ("Bengaluru", "IN", 12.9716, 77.5946, "METRO"),
    ("Chennai", "IN", 13.0827, 80.2707, "METRO"),
    ("Kolkata", "IN", 22.5726, 88.3639, "METRO"),
    ("Hyderabad", "IN", 17.3850, 78.4867, "METRO"),
    ("Ahmedabad", "IN", 23.0225, 72.5714, "METRO"),
    ("Jaipur", "IN", 26.9124, 75.7873, "NON_METRO"),
    ("Lucknow", "IN", 26.8467, 80.9462, "NON_METRO"),
    ("Indore", "IN", 22.7196, 75.8577, "NON_METRO"),
    ("Nagpur", "IN", 21.1458, 79.0882, "NON_METRO"),
    ("Surat", "IN", 21.1702, 72.8311, "NON_METRO"),
    ("Kochi", "IN", 9.9312, 76.2673, "NON_METRO"),
    ("Bhopal", "IN", 23.2599, 77.4126, "NON_METRO"),
    ("Patna", "IN", 25.5941, 85.1376, "NON_METRO"),
    ("Coimbatore", "IN", 11.0168, 76.9558, "NON_METRO"),
    ("Visakhapatnam", "IN", 17.6868, 83.2185, "NON_METRO"),
    ("Chandigarh", "IN", 30.7333, 76.7794, "NON_METRO"),
    ("Guwahati", "IN", 26.1445, 91.7362, "NON_METRO"),
    ("Singapore", "SG", 1.3521, 103.8198, "INTL"),
    ("Dubai", "AE", 25.2048, 55.2708, "INTL"),
    ("London", "GB", 51.5072, -0.1276, "INTL"),
    ("New York", "US", 40.7128, -74.0060, "INTL"),
    ("Bangkok", "TH", 13.7563, 100.5018, "INTL"),
    ("Colombo", "LK", 6.9271, 79.8612, "INTL"),
    ("Port Axa", "XA", 5.1000, 40.2000, "INTL"),
    ("Axa North", "XA", 7.4000, 41.0000, "INTL"),
    ("Bexton", "XB", -3.2000, 30.1000, "INTL"),
    ("Bexton Bay", "XB", -4.0000, 31.5000, "INTL"),
    ("Cayra", "XC", 14.6000, 60.3000, "INTL"),
    ("Cayra East", "XC", 15.1000, 61.0000, "INTL"),
]
COUNTRIES = [
    ("IN", "India", "LOW"), ("SG", "Singapore", "LOW"), ("AE", "United Arab Emirates", "LOW"),
    ("GB", "United Kingdom", "LOW"), ("US", "United States", "LOW"), ("TH", "Thailand", "LOW"),
    ("XA", "Axaland (fictional)", "HIGH"), ("XB", "Bexland (fictional)", "HIGH"), ("XC", "Cayland (fictional)", "HIGH"),
]
MCCS = [
    ("5411", "Grocery Stores, Supermarkets", "GROCERY", "N"),
    ("5732", "Electronics Stores", "ELECTRONICS", "N"),
    ("5812", "Eating Places, Restaurants", "DINING", "N"),
    ("5541", "Service Stations", "FUEL", "N"),
    ("4111", "Commuter Transport", "TRANSPORT", "N"),
    ("5311", "Department Stores", "RETAIL", "N"),
    ("5999", "Miscellaneous Retail", "RETAIL", "N"),
    ("5912", "Drug Stores and Pharmacies", "HEALTH", "N"),
    ("4511", "Airlines", "TRAVEL", "N"),
    ("7011", "Hotels and Lodging", "TRAVEL", "N"),
    ("5651", "Family Clothing Stores", "RETAIL", "N"),
    ("5944", "Jewelry Stores", "LUXURY", "N"),
    ("6011", "ATM Cash Disbursement", "CASH", "N"),
    ("4829", "Wire Transfer, Money Orders", "MONEY_TRANSFER", "Y"),
    ("5967", "Direct Marketing - Inbound Teleservices", "DIRECT_MARKETING", "Y"),
    ("6051", "Quasi Cash - Crypto, Foreign Currency", "QUASI_CASH", "Y"),
    ("7995", "Betting, Casino Gambling", "GAMBLING", "Y"),
]
MCC_INFO = {m[0]: m for m in MCCS}
CITY = {c[0]: c for c in CITIES}

write_csv("cities", ["city", "country", "lat", "lon", "city_tier"], CITIES)
write_csv("country_risk", ["country_code", "country_name", "risk_level"], COUNTRIES)
write_csv("mcc_codes", ["mcc", "mcc_description", "mcc_category", "high_risk"], MCCS)

# merchants: M00001..M00449 random, M00450.. fixed for the worked examples
merchants = []
in_cities = [c[0] for c in CITIES if c[1] == "IN"]
for i in range(1, 450):
    mcc = rng.choice(MCCS)
    city = rng.choice(in_cities) if rng.random() < 0.88 else rng.choice([c[0] for c in CITIES if c[1] != "IN"])
    r = rng.random()
    risk = "LOW" if r < 0.7 else "MEDIUM" if r < 0.9 else "HIGH" if r < 0.97 else "BLACKLISTED"
    if mcc[3] == "Y" and risk == "LOW":
        risk = "MEDIUM"
    merchants.append((f"M{i:05d}", f"Merchant {i:03d} {mcc[2].title()}", mcc[0], mcc[1], city, CITY[city][1], risk))
fixed_merchants = [
    ("M00450", "Sagar Mart Andheri", "5411", "Mumbai", "LOW"),
    ("M00451", "Bluebird Electronics Online", "5732", "Mumbai", "LOW"),
    ("M00452", "Coral Coin Exchange", "6051", "Mumbai", "MEDIUM"),
    ("M00453", "Orchid Stores Orchard Road", "5311", "Singapore", "LOW"),
    ("M00454", "Connaught Place Grocers", "5411", "Delhi", "LOW"),
    ("M00455", "Pune Fresh Mart", "5411", "Pune", "LOW"),
]
for mid, name, mcc, city, risk in fixed_merchants:
    merchants.append((mid, name, mcc, MCC_INFO[mcc][1], city, CITY[city][1], risk))
write_csv("merchants", ["merchant_id", "merchant_name", "mcc", "mcc_description", "city", "country", "merchant_risk"], merchants)
MERCH = {m[0]: m for m in merchants}

# ---------------------------------------------------------------- customers and cards
FIRST = ["Aarav", "Diya", "Rohan", "Ananya", "Kabir", "Isha", "Vikram", "Meera", "Arjun", "Sneha", "Karan", "Priya",
         "Rahul", "Neha", "Aditya", "Pooja", "Siddharth", "Kavya", "Manish", "Ritu"]
LAST = ["Sharma", "Iyer", "Patel", "Reddy", "Nair", "Gupta", "Singh", "Das", "Mehta", "Rao", "Kulkarni", "Joshi"]
N_CARDS = 200
customers, cards = [], []
for i in range(N_CARDS):
    cid = f"CU{1001 + i:04d}"
    fn, ln = rng.choice(FIRST), rng.choice(LAST)
    home = "Mumbai" if i < 10 else rng.choice(in_cities)
    customers.append((cid, f"{fn} {ln}", f"9{rng.randint(100000000, 999999999)}", f"{fn.lower()}.{ln.lower()}{i}@example.com",
                      home, f"{fn.lower()}{1001 + i}"))
    card_id = f"C{1001 + i}"
    number = "9999" + "".join(str(rng.randint(0, 9)) for _ in range(12))
    if i < 10:
        ctype, status, issue, expiry, limit, intl = "DEBIT", "ACTIVE", "2023-01-15", "2029-12-31", "100000.00", "N"
        if card_id == "C1002":
            status = "BLOCKED"
    else:
        ctype = rng.choice(["DEBIT", "CREDIT"])
        status = "ACTIVE" if rng.random() < 0.95 else rng.choice(["BLOCKED", "EXPIRED"])
        issue = (date(2019, 1, 1) + timedelta(days=rng.randint(0, 2400))).isoformat()
        expiry = "2025-06-30" if status == "EXPIRED" else f"{rng.randint(2027, 2031)}-{rng.randint(1, 12):02d}-28"
        limit = rng.choice(["50000.00", "100000.00", "200000.00", "300000.00"])
        intl = "Y" if rng.random() < 0.3 else "N"
    cards.append((card_id, cid, number, ctype, status, issue, expiry, home, "IN", limit, intl))
# one extra customer without a card, matching the "one more customer than cards" shape
customers.append(("CU9999", "Test Customer", "9000000000", "test.customer@example.com", "Mumbai", "testcustomer"))
write_csv("customers", ["customer_id", "full_name", "mobile", "email", "city", "username"], customers)
write_csv("cards", ["card_id", "customer_id", "card_number", "card_type", "card_status", "issue_date", "expiry_date",
                    "home_city", "home_country", "daily_limit", "international_enabled"], cards)

# ---------------------------------------------------------------- transaction history
history = []
seq = [100000000]


def add(card_id, dt, amount, mid, channel, city=None, status="APPROVED"):
    seq[0] += 1
    m = MERCH[mid]
    city = city or m[4]
    history.append((f"T{seq[0]}", card_id, dt, f"{amount:.2f}", mid, m[2], channel, city, CITY[city][1], status))


day0 = datetime(2026, 3, 4, tzinfo=IST)
# worked-example cards: 20 APPROVED x 2,400 in the 30 days before 2026-03-04, none on 2026-03-04
for i in range(10):
    card_id = f"C{1001 + i}"
    for k in range(20):
        dt = day0 - timedelta(days=28 - k) + timedelta(hours=11, minutes=(k * 7) % 50)
        if k % 2 == 0:
            add(card_id, dt, 2400, "M00450", "POS", "Mumbai")
        else:
            add(card_id, dt, 2400, "M00451", "ECOM", "Mumbai")
add("C1004", day0.replace(hour=9, minute=0), 92000, "M00450", "POS", "Mumbai")
add("C1005", day0.replace(hour=13, minute=5), 2400, "M00450", "POS", "Mumbai")
add("C1006", day0.replace(hour=13, minute=5), 2400, "M00450", "POS", "Mumbai")
for hh, mm in [(13, 56), (13, 59), (14, 2)]:
    add("C1009", day0.replace(hour=hh, minute=mm), 1200, "M00451", "ECOM", "Mumbai")

start = datetime(2025, 12, 4, tzinfo=IST)
span_minutes = int((datetime(2026, 3, 4, tzinfo=IST) - start).total_seconds() // 60)
target_rows = 9000
while len(history) < target_rows:
    card = rng.choice(cards[10:])
    dt = start + timedelta(minutes=rng.randint(0, span_minutes))
    mid = rng.choice(merchants[:449])[0]
    channel = rng.choice(["POS", "POS", "ECOM", "ECOM", "CONTACTLESS", "ATM"])
    amount = round(float(np_rng.lognormal(7.6, 0.9)), 2)
    status = "APPROVED" if rng.random() < 0.97 else "BLOCKED"
    city = card[7] if channel != "ECOM" else MERCH[mid][4]
    add(card[0], dt, min(amount, 150000), mid, channel, city, status)
history.sort(key=lambda r: (r[2], r[0]))
write_csv("transactions_history", ["txn_id", "card_id", "txn_ts", "amount", "merchant_id", "mcc", "channel", "txn_city",
                                   "txn_country", "status"], [(r[0], r[1], ts(r[2]), *r[3:]) for r in history])

# ---------------------------------------------------------------- sample batch = worked examples 1-10
sample = [
    # txn_id, card, time, amount, merchant, channel, city, decision, codes, score, vel, avg, speed
    ("T200000001", "C1001", "14:05", 3500, "M00450", "POS", "Mumbai", "APPROVE", "", "0", "0", "2400.00", ""),
    ("T200000002", "C1002", "14:05", 3500, "M00450", "POS", "Mumbai", "BLOCK", "CARD_NOT_ACTIVE", "", "", "", ""),
    ("T200000003", "C1003", "14:05", 3500, "M00453", "POS", "Singapore", "BLOCK", "INTL_NOT_ENABLED", "", "", "", ""),
    ("T200000004", "C1004", "14:05", 9500, "M00450", "POS", "Mumbai", "BLOCK", "DAILY_LIMIT_EXCEEDED", "100", "0", "6666.67", "0.00"),
    ("T200000005", "C1005", "14:05", 4000, "M00454", "POS", "Delhi", "BLOCK", "IMPOSSIBLE_TRAVEL", "100", "0", "2400.00", "1148.09"),
    ("T200000006", "C1006", "14:05", 3000, "M00455", "POS", "Pune", "APPROVE", "", "0", "0", "2400.00", "120.15"),
    ("T200000007", "C1007", "14:05", 15000, "M00451", "ECOM", "Mumbai", "STEP_UP", "AMOUNT_SPIKE", "30", "0", "2400.00", ""),
    ("T200000008", "C1008", "14:05", 12000, "M00451", "ECOM", "Mumbai", "APPROVE", "", "0", "0", "2400.00", ""),
    ("T200000009", "C1009", "14:05", 1200, "M00451", "ECOM", "Mumbai", "STEP_UP", "HIGH_VELOCITY", "25", "3", "2243.48", ""),
    ("T200000010", "C1010", "02:30", 45000, "M00452", "ECOM", "Mumbai", "BLOCK",
     "AMOUNT_SPIKE|HIGH_RISK_MCC|ODD_HOUR_HIGH_VALUE|NEW_MERCHANT_HIGH_VALUE|MULTIPLE_RED_FLAGS", "80", "0", "2400.00", ""),
]
rows = []
for t in sample:
    hh, mm = map(int, t[2].split(":"))
    dt = day0.replace(hour=hh, minute=mm)
    m = MERCH[t[4]]
    rows.append((t[0], t[1], ts(dt), f"{t[3]:.2f}", "INR", t[4], m[2], t[5], t[6], CITY[t[6]][1], *t[7:]))
write_csv("batch_transactions_sample", ["txn_id", "card_id", "txn_ts", "amount", "currency", "merchant_id", "mcc", "channel",
                                        "txn_city", "txn_country", "expected_decision", "expected_reason_codes",
                                        "expected_rule_risk_score", "expected_velocity_10m", "expected_avg_amount_30d",
                                        "expected_speed_kmph"], rows)
write_csv("batch_sample_expected_alerts", ["txn_id", "alert_priority", "sla_due_at"], [
    ("T200000005", "HIGH", "2026-03-04T14:35:00+05:30"),
    ("T200000010", "HIGH", "2026-03-04T03:00:00+05:30"),
])

# a small "evaluation-like" batch (no expected columns) on other cards, 2026-03-05
eval_rows = []
for k in range(40):
    card = cards[10 + k]
    dt = datetime(2026, 3, 5, tzinfo=IST) + timedelta(minutes=rng.randint(0, 1439))
    mid = rng.choice(merchants)[0]
    m = MERCH[mid]
    channel = rng.choice(["POS", "ECOM", "CONTACTLESS", "ATM"])
    city = m[4] if channel == "ECOM" else card[7]
    eval_rows.append((f"T300{k + 1:06d}", card[0], ts(dt), f"{round(rng.uniform(200, 80000), 2):.2f}", "INR", mid, m[2],
                      channel, city, CITY[city][1]))
eval_rows.sort(key=lambda r: (r[2], r[0]))
write_csv("batch_transactions_eval", ["txn_id", "card_id", "txn_ts", "amount", "currency", "merchant_id", "mcc", "channel",
                                      "txn_city", "txn_country"], eval_rows)

# ---------------------------------------------------------------- rules configuration
config = {
    "version": "1.0",
    "velocity_window_minutes": 10, "velocity_burst_count": 5, "velocity_step_up_count": 3,
    "amount_spike_multiplier": 5, "amount_spike_min_amount": 10000, "amount_spike_no_history_amount": 50000,
    "avg_amount_lookback_days": 30,
    "impossible_travel_speed_kmph": 800, "impossible_travel_lookback_hours": 6,
    "odd_hour_start": "00:00", "odd_hour_end": "04:59", "odd_hour_min_amount": 20000,
    "new_merchant_min_amount": 25000, "new_merchant_lookback_days": 90,
    "high_risk_mcc_list": ["4829", "5967", "6051", "7995"],
    "multiple_red_flags_count": 3,
    "points": {"R7": 25, "R8": 30, "R9": 25, "R10": 15, "R11": 15, "R12": 20},
    "rule_risk_score_cap": 100,
    "step_up_expiry_minutes": 15,
    "maker_checker_limit": 100000,
    "sla_minutes": {"HIGH": 30, "MEDIUM": 240},
    "alert_high_priority_amount": 50000,
    "ai_step_up_threshold": 0.70, "ai_block_threshold": 0.90,
}
with open(os.path.join(OUT, f"case_01_rules_config_{V}.json"), "w") as f:
    json.dump(config, f, indent=2)

# ---------------------------------------------------------------- labelled transactions (AI track)
n = 100_000
lab_start = datetime(2025, 9, 1, tzinfo=IST)
lab_span = int((datetime(2026, 3, 1, tzinfo=IST) - lab_start).total_seconds())
secs = np.sort(np_rng.integers(0, lab_span, n))
mcc_codes = np.array([m[0] for m in MCCS])
mcc_p = np.array([10, 8, 10, 7, 6, 6, 6, 5, 3, 3, 5, 2, 6, 1.2, 1, 1, 0.8])
mcc_idx = np_rng.choice(len(MCCS), n, p=mcc_p / mcc_p.sum())
channel = np_rng.choice(["POS", "ECOM", "ATM", "CONTACTLESS"], n, p=[0.4, 0.33, 0.1, 0.17])
card_type = np_rng.choice(["DEBIT", "CREDIT"], n, p=[0.62, 0.38])
merchant_risk = np_rng.choice(["LOW", "MEDIUM", "HIGH", "BLACKLISTED"], n, p=[0.72, 0.2, 0.07, 0.01])
city_tier = np_rng.choice(["METRO", "NON_METRO", "INTL"], n, p=[0.55, 0.4, 0.05])
is_intl = (city_tier == "INTL").astype(int)
country_risk_high = ((is_intl == 1) & (np_rng.random(n) < 0.3)).astype(int)
amount = np.round(np_rng.lognormal(7.7, 1.0, n), 2).clip(10, 1_000_000)
local_hour = np_rng.choice(24, n, p=np.r_[np.full(5, 0.012), np.full(19, (1 - 0.06) / 19)])
distance = np.where(is_intl == 1, np_rng.uniform(1500, 9000, n),
                    np.where(channel == "ECOM", np_rng.uniform(0, 1500, n), np_rng.exponential(15, n)))
velocity_10m = np_rng.poisson(0.15, n)
velocity_24h = velocity_10m + np_rng.poisson(2.0, n)
has_hist = np_rng.random(n) < 0.93
ratio = np.where(has_hist, amount / np.exp(np_rng.normal(7.7, 0.5, n)), np.nan)
new_merchant = (np_rng.random(n) < 0.3).astype(int)
card_age = np_rng.integers(5, 3000, n)
hr_mcc = np.isin(mcc_codes[mcc_idx], ["4829", "5967", "6051", "7995"]).astype(int)

logit = (-7.0 + 1.5 * np.minimum(velocity_10m, 6) + 0.9 * np.log1p(np.nan_to_num(ratio, nan=1.0))
         + 2.2 * ((local_hour <= 4) & (amount > 15000)) + 1.7 * hr_mcc + 2.2 * country_risk_high
         + 1.5 * (new_merchant & (channel == "ECOM")) + 1.1 * (merchant_risk == "HIGH") + 3.0 * (merchant_risk == "BLACKLISTED")
         + 0.9 * (card_age < 60) + 0.25 * np.log1p(distance) / 3 + 0.3 * (card_type == "CREDIT"))
p = 1 / (1 + np.exp(-logit))
is_fraud = (np_rng.random(n) < p).astype(int)

with open(os.path.join(OUT, f"case_01_labelled_transactions_{V}.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["txn_id", "txn_ts", "card_type", "channel", "mcc", "mcc_category", "merchant_risk", "amount", "local_hour",
                "is_international", "country_risk_high", "distance_from_home_km", "velocity_10m", "velocity_24h",
                "amount_to_avg30_ratio", "new_merchant_flag", "card_age_days", "city_tier", "is_fraud"])
    for i in range(n):
        dt = lab_start + timedelta(seconds=int(secs[i]))
        dt = dt.replace(hour=int(local_hour[i]))
        m = MCCS[mcc_idx[i]]
        w.writerow([f"L{i + 1:09d}", ts(dt), card_type[i], channel[i], m[0], m[2], merchant_risk[i], f"{amount[i]:.2f}",
                    int(local_hour[i]), int(is_intl[i]), int(country_risk_high[i]), f"{distance[i]:.2f}", int(velocity_10m[i]),
                    int(velocity_24h[i]), "" if math.isnan(ratio[i]) else f"{ratio[i]:.4f}", int(new_merchant[i]),
                    int(card_age[i]), city_tier[i], int(is_fraud[i])])

with open(os.path.join(OUT, "SYNTHETIC_DATA_README.txt"), "w") as f:
    f.write("This directory contains SYNTHETIC stand-in data generated by scripts/generate_synthetic_data.py.\n"
            "It is not the official case-study data pack. Copy the official files into ./data to use them.\n")
print(f"synthetic data written to {os.path.abspath(OUT)}; labelled fraud rate {is_fraud.mean():.4f}; history rows {len(history)}")
