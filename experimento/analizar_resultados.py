import argparse
import json
import os
from urllib.parse import parse_qs

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

FASES = ["reposo", "batch", "post_batch"]
COLOR_FASE = {"reposo": "#e8f5e9", "batch": "#fff3e0", "post_batch": "#e3f2fd"}


def tags(cadena):
    if not isinstance(cadena, str):
        return {}
    return {k: v[0] for k, v in parse_qs(cadena).items()}


def cargar(ruta):
    df = pd.read_csv(ruta, low_memory=False)
    t = df["extra_tags"].apply(tags)
    df["fase"] = t.apply(lambda x: x.get("fase"))
    df["tipo"] = t.apply(lambda x: x.get("tipo"))
    return df


def analizar(ruta, fase_s, salida):
    nombre = os.path.splitext(os.path.basename(ruta))[0]
    df = cargar(ruta)

    dur = df[(df.metric_name == "http_req_duration") & (df.tipo == "cotizacion_online")].copy()
    chk = df[df.metric_name == "checks"].copy()
    tps = df[df.metric_name == "batch_throughput_perfiles_seg"].copy()
    tot = df[df.metric_name == "batch_perfiles_reprocesados"].copy()

    t0 = dur.timestamp.min()
    for d in (dur, chk, tps, tot):
        if len(d):
            d["seg"] = d.timestamp - t0

    filas = []
    for fase in FASES:
        c = chk[chk.fase == fase]
        d = dur[dur.fase == fase]
        tp = tps[(tps.fase == fase) & (tps.metric_value > 0)]
        total = len(c)
        exitosas = int(c.metric_value.sum()) if total else 0
        tps_prom = round(tp.metric_value.mean(), 1) if len(tp) else 0.0
        tps_max = round(tp.metric_value.max(), 1) if len(tp) else 0.0
        filas.append({
            "corrida": nombre,
            "fase": fase,
            "peticiones_online": total,
            "exitosas": exitosas,
            "disponibilidad_%": round(100 * exitosas / total, 3) if total else None,
            "p50_ms": round(d.metric_value.quantile(0.50), 1) if len(d) else None,
            "p95_ms": round(d.metric_value.quantile(0.95), 1) if len(d) else None,
            "p99_ms": round(d.metric_value.quantile(0.99), 1) if len(d) else None,
            "max_ms": round(d.metric_value.max(), 1) if len(d) else None,
            "batch_tps_prom": tps_prom,
            "batch_tps_pico": tps_max,
            "proyeccion_10M_h": round(10_000_000 / tps_prom / 3600, 2) if tps_prom > 0 else None,
        })

    dur["ventana"] = (dur.seg // 5) * 5
    p50 = dur.groupby("ventana").metric_value.quantile(0.50)
    p95 = dur.groupby("ventana").metric_value.quantile(0.95)
    p99 = dur.groupby("ventana").metric_value.quantile(0.99)

    fig, ejes = plt.subplots(3, 1, figsize=(11, 10), sharex=True)
    for eje in ejes:
        for i, fase in enumerate(FASES):
            eje.axvspan(i * fase_s, (i + 1) * fase_s, color=COLOR_FASE[fase], zorder=0)

    # Panel 1: Latencia Online (Distribucion -> Identidad API)
    ejes[0].plot(p50.index, p50.values, marker=".", label="p50 Online", color="#2e7d32")
    ejes[0].plot(p95.index, p95.values, marker=".", label="p95 Online", color="#1565c0")
    ejes[0].plot(p99.index, p99.values, marker=".", label="p99 Online", color="#6a1b9a", alpha=0.8)
    ejes[0].axhline(250, ls="--", color="orange", lw=1.2, label="SLA p95 <= 250 ms")
    ejes[0].axhline(500, ls="--", color="red", lw=1.2, label="SLA p99 <= 500 ms")
    ejes[0].set_ylabel("Latencia Online (ms)")
    ejes[0].legend(loc="upper right", ncol=3)
    ejes[0].set_title("Tráfico en Línea: Distribución -> Identidad API -> RDS Primary")

    # Panel 2: Throughput de Reprocesamiento Batch (perfiles/seg)
    if len(tps):
        ejes[1].plot(tps["seg"], tps["metric_value"], marker="o", color="#e65100", label="Throughput Batch (perfiles/s)")
    ejes[1].axhline(1400, ls="--", color="red", lw=1.2, label="Meta ASR >= 1.400 perfiles/s (10M < 2h)")
    ejes[1].set_ylabel("Perfiles / seg")
    ejes[1].legend(loc="upper right")
    ejes[1].set_title("Workers Identidad (Competing Consumers): SQS + RDS Read Replica")

    # Panel 3: Perfiles acumulados reprocesados
    if len(tot):
        ejes[2].plot(tot["seg"], tot["metric_value"], marker=".", color="#00695c", label="Perfiles Reprocesados Acumulados")
    ejes[2].set_ylabel("Perfiles Reprocesados")
    ejes[2].set_xlabel("Segundos desde el inicio del experimento")
    ejes[2].legend(loc="lower right")

    fig.suptitle(f"ASR Escalabilidad · Reprocesamiento Batch de Perfiles ({nombre})\n(Verde: Reposo Online · Naranja: Pico Batch SQS · Azul: Post-Batch)")
    fig.tight_layout()
    fig.savefig(os.path.join(salida, f"{nombre}.png"), dpi=140)
    plt.close(fig)
    return filas


def main():
    p = argparse.ArgumentParser()
    p.add_argument("csv", nargs="+")
    p.add_argument("--fase-s", type=int, default=60)
    p.add_argument("--salida", default="analisis")
    a = p.parse_args()
    os.makedirs(a.salida, exist_ok=True)
    todas = []
    for ruta in a.csv:
        f = analizar(ruta, a.fase_s, a.salida)
        todas += f
    tabla = pd.DataFrame(todas)
    tabla.to_csv(os.path.join(a.salida, "tabla-por-fase.csv"), index=False)
    pd.set_option("display.width", 250)
    print(tabla.to_string(index=False))


if __name__ == "__main__":
    main()
