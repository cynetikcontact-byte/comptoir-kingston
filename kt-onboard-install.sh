#!/bin/bash
# ============================================================
# KINGTOOLS - Préparation du Raspberry MAÎTRE pour l'onboarding par code
# ------------------------------------------------------------
# A lancer UNE SEULE FOIS sur le Raspberry d'Aix (le "maître"), puis re-cloner.
# Après ça, tout nouveau clone se configure via l'outil web Installe-Pont :
# on écrit un code sur sa clé USB, il résout sa boutique et s'appaire seul.
#
#   curl -fsSL https://kingtools.fr/kt-onboard-install.sh | sudo bash
#
# Sûr sur Aix : sauvegarde le service, PRÉSERVE le jeton actuel d'Aix,
# vérifie que le pont tourne toujours à la fin. Idempotent.
# ============================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "!! Lance avec sudo : curl ... | sudo bash"; exit 1; }

SVC=/etc/systemd/system/kingston-pont.service
ENVF=/etc/kingston-pont.env
[ -f "$SVC" ] || { echo "!! $SVC introuvable : ce n'est pas un pont KINGTOOLS."; exit 1; }

echo "== 1/5  Sauvegarde du service =="
cp -n "$SVC" "$SVC.avant-onboard" 2>/dev/null || true
echo "    -> $SVC.avant-onboard"

echo "== 2/5  Préservation du jeton actuel (Aix garde son appairage) =="
CUR_TOKEN=$(grep -oE 'KT_SETUP_TOKEN=[^"]*' "$SVC" | head -1 | cut -d= -f2- | tr -d ' "') || true
if [ ! -f "$ENVF" ]; then
  umask 077
  if [ -n "${CUR_TOKEN:-}" ]; then echo "KT_SETUP_TOKEN=$CUR_TOKEN" > "$ENVF"; echo "    -> jeton actuel copié dans $ENVF";
  else : > "$ENVF"; echo "    -> $ENVF créé (vide, sera rempli à l'onboarding)"; fi
  chmod 600 "$ENVF"
else
  echo "    -> $ENVF existe déjà, on n'y touche pas"
fi

echo "== 3/5  Le service lit le jeton depuis $ENVF =="
# retire la ligne Environment=KT_SETUP_TOKEN=... (le jeton vient maintenant de $ENVF)
sed -i '/Environment=KT_SETUP_TOKEN=/d' "$SVC"
# ajoute EnvironmentFile (optionnel) juste après [Service] s'il n'y est pas deja
grep -q "EnvironmentFile=-$ENVF" "$SVC" || sed -i "/^\[Service\]/a EnvironmentFile=-$ENVF" "$SVC"
echo "    -> fait"

echo "== 4/5  Script + service d'onboarding =="
cat > /usr/local/sbin/kt-onboard.sh <<'ONB'
#!/bin/bash
# Lie ce Raspberry a une boutique a partir de /boot/firmware/kt-install.txt (ecrit par l'outil Installe-Pont).
set -uo pipefail
BOOTDIR=/boot/firmware; [ -d "$BOOTDIR" ] || BOOTDIR=/boot
CONF="$BOOTDIR/kt-install.txt"
ENVF=/etc/kingston-pont.env
MARK=/var/lib/kt-onboard.applied
SERVER="${KT_SERVER:-https://kingtools.fr}"
LOG=/var/log/kt-onboard.log
exec >>"$LOG" 2>&1
echo "=== kt-onboard $(date '+%F %T') ==="
[ -f "$CONF" ] || { echo "pas de kt-install.txt"; exit 0; }
sum=$(sha1sum "$CONF" | cut -d' ' -f1)
[ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$sum" ] && { echo "deja applique"; exit 0; }
CODE=$(grep -E '^CODE=' "$CONF" | head -1 | cut -d= -f2- | tr -d ' \r')
BQ=$(grep -E '^BOUTIQUE=' "$CONF" | head -1 | cut -d= -f2- | tr -d ' \r')
[ -n "$CODE" ] || { echo "pas de CODE"; exit 0; }
echo "code=$CODE boutique=$BQ"
TOKEN=""; BQID=""
for i in $(seq 1 30); do
  R=$(curl -fsS -m 8 "$SERVER/api/pont/resolve?code=$CODE" 2>/dev/null) || R=""
  TOKEN=$(echo "$R" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  BQID=$(echo "$R" | grep -o '"boutiqueId":"[^"]*"' | cut -d'"' -f4)
  [ -n "$TOKEN" ] && break
  echo "attente reseau/serveur ($i)..."; sleep 6
done
[ -n "$TOKEN" ] || { echo "resolution echouee, nouvel essai au prochain demarrage"; exit 0; }
[ -n "$BQID" ] || BQID="$BQ"
umask 077
echo "KT_SETUP_TOKEN=$TOKEN" > "$ENVF"; chmod 600 "$ENVF"
HN="kingston-pont-$(echo "${BQID:-boutique}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
hostnamectl set-hostname "$HN" 2>/dev/null || true
grep -q '^127.0.1.1' /etc/hosts && sed -i "s/^127.0.1.1.*/127.0.1.1\t$HN/" /etc/hosts || true
rm -f /opt/kingston-pont/tpe-config.json   # nouvel identifiant unique (pas de conflit avec le maitre)
echo "$sum" > "$MARK"
systemctl restart kingston-pont 2>/dev/null || true
echo ">>> APPLIQUE : boutique $BQID, hostname $HN"
ONB
chmod 0755 /usr/local/sbin/kt-onboard.sh

cat > /etc/systemd/system/kt-onboard.service <<'UNIT'
[Unit]
Description=KINGTOOLS onboarding par code (lie le Pi a sa boutique)
After=network-online.target
Wants=network-online.target
Before=kingston-pont.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/kt-onboard.sh

[Install]
WantedBy=multi-user.target
UNIT

# petit timer de rattrapage : reessaie 90s apres le boot (si le reseau tardait)
cat > /etc/systemd/system/kt-onboard.timer <<'UNIT'
[Unit]
Description=KINGTOOLS onboarding - rattrapage apres le demarrage

[Timer]
OnBootSec=90
AccuracySec=15

[Install]
WantedBy=timers.target
UNIT
echo "    -> installés"

echo "== 5/5  Activation + vérification =="
systemctl daemon-reload
systemctl enable kt-onboard.service >/dev/null 2>&1 || true
systemctl enable --now kt-onboard.timer >/dev/null 2>&1 || true
systemctl restart kingston-pont
sleep 3
if systemctl is-active --quiet kingston-pont; then
  echo "    -> pont ACTIF ✓ (Aix continue de fonctionner)"
else
  echo "!! le pont ne redémarre pas — RESTAURATION de la sauvegarde"
  cp "$SVC.avant-onboard" "$SVC"; systemctl daemon-reload; systemctl restart kingston-pont
  echo "!! service restauré. Contacte le support avant de continuer."
  exit 1
fi

echo ""
echo ">>> MAÎTRE PRÊT POUR L'ONBOARDING PAR CODE <<<"
echo "Prochaine étape : RE-CLONER ce Raspberry (SD Card Copier) pour tes nouvelles boutiques."
echo "Chaque clone se configurera ensuite via https://kingtools.fr/installe-pont (code + wifi)."
