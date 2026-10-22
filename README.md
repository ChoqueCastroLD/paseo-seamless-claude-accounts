# paseo-seamless-claude-accounts

Cambia la cuenta de Claude Code en Paseo con un click, **sin reiniciar chats ni perder
conversaciones**.

> Switch the Claude Code account behind every open chat by rewriting the live credentials,
> the same way `claude login` does. No restarts, no lost conversations.

---

## Qué hace

Una pantalla con tus logins de Claude: correo, plan y lo que queda de la ventana de 5 horas y de
7 días. Pulsas **Usar esta** y todo Paseo pasa a esa cuenta.

```
* principal  tu@ejemplo.com        —
  trabajo    trabajo@ejemplo.com    5h 2%   7d 63%
```

Se abre desde la barra lateral (**Cuentas Claude**), con ⌘K → *Cambiar de cuenta Claude*, o
escribiendo `/cuenta capichan` en el composer.

## Por qué existe

Este proyecto nace como **fork de [kostilal/paseo-claude-accounts](https://github.com/kostilal/paseo-claude-accounts)**.

El primer paso fue portarlo a Linux, porque el original lee los tokens del Keychain de macOS y no
tenía ninguna rama para otras plataformas. Ese port funciona y arregla tres cosas reales:

| Arreglo del port | Por qué |
| --- | --- |
| Credenciales desde `<dir>/.credentials.json` | En Linux no hay Keychain; `security` no existe |
| Copia del transcript antes de reiniciar | `--resume` busca la sesión dentro del config dir activo, así que al cambiar de dir respondía `No conversation found` |
| Shell de login elegido en runtime | `/bin/zsh` fijo reventaba el "Add account" en imágenes sin zsh |

Pero al usarlo quedó claro que el modelo del original no puede ser seamless: **un config dir por
cuenta** obliga a `CLAUDE_CONFIG_DIR`, a reiniciar el proceso del chat y a mover transcripts. Eso
es lo que hace que "Move all chats here" recargue todo.

**Este repositorio reescribe el plugin alrededor de un solo fichero de credenciales** —
`~/.claude/.credentials.json`, exactamente el que escribe `claude login`. No hay config dirs, no
hay reinicios, no hay copias de historial.

No reutiliza ficheros de aquel proyecto: el código es nuevo. La deuda es de idea, de enfoque y de
los detalles del endpoint de `usage` que su código documenta. Se mantiene la atribución por eso.

## Qué cambia respecto al original

| | kostilal/paseo-claude-accounts | este |
| --- | --- | --- |
| Plataforma | macOS (Keychain) | macOS y Linux (`.credentials.json`) |
| Modelo | Un config dir por cuenta | Un único fichero de credenciales |
| Cambio de cuenta | Reinicia el chat (`paseo agent reload`) | Reescribe el fichero |
| Velocidad | Segundos, con el chat cortado | Inmediato, sin tocar el chat |
| Alcance | Por chat | Global: todas las sesiones a la vez |
| Historial | Hay que copiar transcripts entre dirs | No se mueve nada |
| Barras de uso | Sí | Sí (5 h y 7 días) |
| Pill por chat | Sí | No (no tiene sentido si es global) |

## Instalar

Desde una copia local:

```sh
paseo plugin install /ruta/a/paseo-seamless-claude-accounts
```

Desde git:

```sh
paseo plugin add git:ChoqueCastroLD/paseo-seamless-claude-accounts
```

Requiere Paseo 0.12 o superior y plugins habilitados (Settings → Plugins).

## Preparar las cuentas

El plugin descubre la cuenta activa (`~/.claude`) y cualquier `~/.claude-*` que tenga su propio
`.credentials.json`. Para tener una segunda cuenta sin tocar la principal:

```sh
CLAUDE_CONFIG_DIR=~/.claude-trabajo claude login
```

Aparecerá sola en la pantalla. El directorio conserva su login, así que volver es otro click.

## Cómo funciona

1. Lee `<perfil>/.credentials.json` y lo escribe en `~/.claude/.credentials.json` con escritura
   atómica (`tmp` + `rename`, modo `600`).
2. Copia el bloque `oauthAccount` a `~/.claude.json`, que es lo que muestra qué dirección está
   autenticada.
3. Nada más. Las sesiones abiertas releen el fichero en su siguiente petición.

## Límites, dichos claro

- **Es global.** Cambiar de cuenta cambia *todos* los chats, también los que están a medias. Es
  el mismo comportamiento que `claude login`, y es lo que lo hace instantáneo. Cuentas distintas
  por chat exigen procesos separados y, por tanto, reinicios: eso es el otro plugin.
- **Posible carrera al refrescar.** Si justo en ese momento una sesión refresca su token, puede
  escribir encima. Pasa rara vez; si ves que no cambió, vuelve a pulsar.
- **Los textos de la interfaz están en español.**
- No hay tests automáticos; la verificación es `npm run typecheck` más una prueba manual de ida y
  vuelta con `md5sum` sobre el fichero de credenciales.

## Desarrollo

```sh
npm install
npm run typecheck
paseo plugin reload seamless-claude-accounts
```

## Licencia

MIT. Ver [LICENSE](LICENSE), que incluye la atribución a
[kostilal/paseo-claude-accounts](https://github.com/kostilal/paseo-claude-accounts).
