#!/bin/bash
# ============================================================
# KINGTOOLS - Configuration d'un pont Raspberry pour une boutique
# ------------------------------------------------------------
# A lancer UNE FOIS sur un Raspberry fraichement CLONE depuis celui d'Aix,
# pendant qu'il est branche en ETHERNET a une box (SSH ou Raspberry Pi Connect).
#
# Il transforme le clone en pont propre a la boutique :
#   - nouvel identifiant unique (evite le conflit avec le pont d'Aix)
#   - jeton de boutique -> le pont s'appaire tout seul a la bonne boutique
#   - Wi-Fi de la boutique (+ reseau de secours KINGTOOLS-SOS)
#   - nom d'hote unique (kingston-pont-<boutique>)
#
# USAGE :
#   curl -fsSL https://kingtools.fr/boutique-setup.sh | sudo bash -s -- \
#        "<ID_BOUTIQUE>" "<JETON>" "<NOM_WIFI>" "<MOT_DE_PASSE_WIFI>" "<Nom lisible>"
#
# EXEMPLE :
#   curl -fsSL https://kingtools.fr/boutique-setup.sh | sudo bash -s -- \
#        "marseille" "a1b2c3..." "Livebox-1234" "motdepasse" "KINGSTON Marseille"
#
# Le JETON s'obtient dans KINGTOOLS -> Reglages -> Paiement par carte ->
# Installation automatique -> choisir la boutique -> "Generer le lien"
# (le jeton est le code apres "token=" dans le lien).
# ============================================================
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "!! Lance avec sudo : sudo bash $0 ..."; exit 1; }

BQ_ID="${1:-}"; TOKEN="${2:-}"; SSID="${3:-}"; WPASS="${4:-}"; LABEL="${5:-$BQ_ID}"
SOS_SSID="KINGTOOLS-SOS"; SOS_PASS="KT-Secours-8541"
SVC=/etc/systemd/system/kingston-pont.service
PONT_DIR=/opt/kingston-pont

if [ -z "$BQ_ID" ] || [ -z "$TOKEN" ] || [ -z "$SSID" ] || [ -z "$WPASS" ]; then
  echo "!! Arguments manquants."
  echo "   Usage : sudo bash $0 \"<ID_BOUTIQUE>\" \"<JETON>\" \"<NOM_WIFI>\" \"<MDP_WIFI>\" \"<Nom lisible>\""
  exit 1
fi
[ -f "$SVC" ] || { echo "!! $SVC introuvable : ce Raspberry n'est pas un clone du pont d'Aix."; exit 1; }

echo "=========================================================="
echo " Configuration du pont pour : $LABEL  (id: $BQ_ID)"
echo "=========================================================="

echo "== 1/6  Nom d'hote unique =="
HN="kingston-pont-$(echo "$BQ_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
hostnamectl set-hostname "$HN"
if grep -q '^127.0.1.1' /etc/hosts; then sed -i "s/^127.0.1.1.*/127.0.1.1\t$HN/" /etc/hosts; else echo -e "127.0.1.1\t$HN" >> /etc/hosts; fi
echo "    -> $HN.local"

echo "== 2/6  Jeton de boutique (auto-appairage) =="
sed -i "s|KT_SETUP_TOKEN=.*|KT_SETUP_TOKEN=$TOKEN|" "$SVC"
grep -q "KT_SETUP_TOKEN=$TOKEN" "$SVC" && echo "    -> jeton installe" || { echo "!! echec ecriture jeton"; exit 1; }

echo "== 3/6  Nouvel identifiant unique du pont =="
# supprime la config heritee du clone d'Aix : deviceId + ancienne IP TPE.
# Un nouveau deviceId sera genere au redemarrage -> pas de conflit avec Aix.
rm -f "$PONT_DIR/tpe-config.json"
echo "    -> identifiant reinitialise (sera regenere au demarrage)"

echo "== 4/6  Wi-Fi de la boutique =="
nmcli con delete boutique >/dev/null 2>&1 || true
nmcli con add type wifi ifname wlan0 con-name boutique ssid "$SSID" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$WPASS" \
  connection.autoconnect yes connection.autoconnect-priority 10 >/dev/null
echo "    -> \"$SSID\" enregistre (priorite haute)"

echo "== 5/6  Reseau de secours $SOS_SSID =="
if nmcli -g NAME con show | grep -qx "kt-sos"; then
  echo "    -> deja present"
else
  nmcli con add type wifi ifname wlan0 con-name kt-sos ssid "$SOS_SSID" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$SOS_PASS" \
    connection.autoconnect yes connection.autoconnect-priority -10 >/dev/null
  echo "    -> installe (depannage a distance via partage de connexion telephone)"
fi

echo "== 6/6  Redemarrage du pont =="
systemctl daemon-reload
systemctl restart kingston-pont
sleep 3
systemctl is-active --quiet kingston-pont && echo "    -> pont actif" || echo "!! le pont ne demarre pas (verifier avec: systemctl status kingston-pont)"

echo ""
echo ">>> PONT CONFIGURE POUR $LABEL <<<"
echo ""
echo "ETAPE MANUELLE (une fois, tant que tu es sur ce Pi) :"
echo "  Enregistre ce Raspberry dans Raspberry Pi Connect sous sa propre identite :"
echo "     sudo -u kingston rpi-connect signout ; sudo -u kingston rpi-connect signin"
echo "  Suis le lien affiche et connecte-toi avec ton compte Raspberry Pi Connect."
echo ""
echo "ENSUITE :"
echo "  1) Debranche le cable Ethernet -> le Pi rejoint le Wi-Fi \"$SSID\"."
echo "  2) Installe-le dans la boutique, branche le TPE au meme reseau."
echo "  3) Verifie dans KINGTOOLS -> Ponts TPE : \"$LABEL\" doit passer EN LIGNE."
echo "=========================================================="
