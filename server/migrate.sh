#!/bin/bash
# Перенос магазина coulair.ru на другой сервер (Ubuntu 22.04/24.04).
#
#   на старом сервере:  bash migrate.sh pack            → /root/coulair-bundle.tgz
#   на новом сервере:   bash migrate.sh install FILE    — ставит nginx, Node, API, сайт, сертификат
#
# В архиве .env с ключами ЮKassa/Telegram и сертификат — архив никуда не выкладывать.
# После install сайт уже работает на новом IP; останется сменить A-запись домена.
set -euo pipefail

SITE=/var/www/coulair
API=/opt/coulair-api
DATA=/var/lib/coulair-api

pack() {
  local tmp out=/root/coulair-bundle.tgz rel
  tmp=$(mktemp -d)
  rel=$(readlink -f $SITE/current)
  mkdir -p $tmp/site $tmp/etc
  cp -a $API $tmp/api
  cp -a $DATA $tmp/data
  cp -a "$rel" $tmp/site/
  basename "$rel" > $tmp/site/CURRENT
  cp /etc/systemd/system/coulair-api.service $tmp/etc/
  cp "$(readlink -f /etc/nginx/sites-enabled/default)" $tmp/etc/nginx-coulair.conf
  cp -a /etc/letsencrypt $tmp/etc/letsencrypt
  grep -E '\sapi\.telegram\.org$' /etc/hosts > $tmp/etc/hosts.add || true
  cp "$(command -v node)" $tmp/node          # запасной Node, если на новом сервере не скачается
  tar czf $out -C $tmp .
  chmod 600 $out
  rm -rf $tmp
  echo "Готово: $out ($(du -h $out | cut -f1)), релиз $(basename "$rel")"
}

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }

install_node() {
  node_ok && return
  local v=v22.23.0 arch=x64
  [ "$(uname -m)" = aarch64 ] && arch=arm64
  if curl -fsSL --max-time 120 "https://nodejs.org/dist/$v/node-$v-linux-$arch.tar.xz" -o /tmp/node.txz; then
    tar xJf /tmp/node.txz -C /usr/local --strip-components=1 && rm /tmp/node.txz
  fi
  node_ok || install -m 755 "$1/node" /usr/local/bin/node
  node_ok || { echo 'Не удалось поставить Node.js 20+'; exit 1; }
}

install() {
  local bundle=${1:?укажите архив: migrate.sh install /root/coulair-bundle.tgz} tmp rel
  tmp=$(mktemp -d)
  tar xzf "$bundle" -C $tmp
  rel=$(cat $tmp/site/CURRENT)

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq nginx certbot python3-certbot-nginx curl xz-utils
  install_node $tmp

  id coulair >/dev/null 2>&1 || useradd --system --home-dir $API --shell /usr/sbin/nologin coulair

  # API и данные заказов
  if [ -d $API ]; then mv $API $API.old.$(date +%s); fi
  cp -a $tmp/api $API
  chown -R root:root $API && chown root:coulair $API/.env && chmod 640 $API/.env
  mkdir -p $DATA && cp -a $tmp/data/. $DATA/
  chown -R coulair:coulair $DATA && chmod 750 $DATA

  # сайт
  mkdir -p $SITE/releases
  rm -rf "$SITE/releases/$rel" && cp -a "$tmp/site/$rel" $SITE/releases/
  chown -R root:root $SITE && chmod -R a+rX $SITE
  ln -sfn "$SITE/releases/$rel" $SITE/current

  # служба: путь к node на новом сервере может отличаться
  sed "s|^ExecStart=[^ ]*node |ExecStart=$(command -v node) |" $tmp/etc/coulair-api.service > /etc/systemd/system/coulair-api.service
  systemctl daemon-reload
  systemctl enable --now coulair-api
  systemctl restart coulair-api

  # сертификат и nginx (сертификат переносится, поэтому https работает сразу, ещё до смены DNS)
  cp -a $tmp/etc/letsencrypt/. /etc/letsencrypt/
  ip=$(curl -4fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
  sed -E "s/(server_name [^;]*) [0-9.]+;/\1 $ip;/" $tmp/etc/nginx-coulair.conf > /etc/nginx/sites-available/coulair
  ln -sfn /etc/nginx/sites-available/coulair /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx && systemctl reload nginx

  [ -s $tmp/etc/hosts.add ] && ! grep -q 'api\.telegram\.org' /etc/hosts && cat $tmp/etc/hosts.add >> /etc/hosts

  # открыть порты, если включён ufw
  if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80,443/tcp; fi
  rm -rf $tmp

  sleep 2
  echo '--- проверка'
  systemctl is-active coulair-api nginx
  curl -s 127.0.0.1:3100/api/health; echo
  curl -sk -o /dev/null -w 'https://coulair.ru → %{http_code}\n' --resolve coulair.ru:443:127.0.0.1 https://coulair.ru/
  echo "Новый IP: $ip — поменяйте A-записи coulair.ru и www.coulair.ru на него."
}

case ${1:-} in
  pack) pack ;;
  install) shift; install "$@" ;;
  *) echo 'migrate.sh pack | install FILE'; exit 1 ;;
esac
