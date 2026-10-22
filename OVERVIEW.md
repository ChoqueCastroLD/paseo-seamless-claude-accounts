# Seamless Claude Accounts

Cambia la cuenta de Claude Code que usa Paseo con un click, sin reiniciar ningún chat.

Funciona igual que `claude login`: escribe las credenciales de la cuenta elegida en
`~/.claude/.credentials.json`. Las conversaciones abiertas conservan su historial y pasan a
facturar el siguiente mensaje contra la cuenta nueva, porque las sesiones releen ese fichero en
cada petición. El cambio afecta a todas las sesiones a la vez y es inmediato.

Las cuentas se descubren como directorios `~/.claude-*` con su propio `.credentials.json`, más la
cuenta activa. Para añadir una, inicia sesión en un directorio aparte:

```sh
CLAUDE_CONFIG_DIR=~/.claude-trabajo claude login
```

Cada tarjeta muestra el correo, el plan y el consumo de la ventana de 5 horas y de 7 días, leído
del endpoint de uso de Anthropic con el token de esa cuenta. Nada se envía a terceros.

La pantalla se abre desde la barra lateral, desde el Command Center o con `/cuenta <nombre>`.

Límites: el cambio es global, no por chat; y los textos de la interfaz están en español. Este
plugin no reutiliza código de `kostilal/paseo-claude-accounts`, pero nace como fork suyo y
mantiene su atribución.
