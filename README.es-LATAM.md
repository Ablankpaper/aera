# Aera

Aera es la aplicación de escritorio de Aera para instalar, configurar y utilizar Aera Runtime. Integra chat, sesiones, agentes, memoria, habilidades, herramientas, tareas programadas, gateways de mensajería, proveedores y una oficina 3D en una sola interfaz nativa.

[Releases](https://github.com/Ablankpaper/aera/releases) · [Issues](https://github.com/Ablankpaper/aera/issues) · [Licencia](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · Español (LATAM)

> Aera está en desarrollo activo. Las funciones y los detalles de empaquetado pueden cambiar entre versiones.

## Funciones principales

- Instalación guiada y actualizaciones de Aera Runtime
- Modos local, túnel SSH y servidor remoto
- Chat en streaming con herramientas, archivos, comandos slash, razonamiento y datos de uso
- Configuración, sesiones, memoria, habilidades y personalidad aisladas por agente
- Gestión de proveedores y modelos alojados o locales compatibles con OpenAI
- Búsqueda y continuación de sesiones, tareas programadas, gateways y Kanban
- Copias de seguridad, importación, diagnóstico, logs y actualización automática
- Oficina interactiva de Aera y showroom de Aera Motors
- Interfaz localizada en 12 idiomas

## Instalación

Descarga la versión más reciente para macOS, Windows o Linux desde [GitHub Releases](https://github.com/Ablankpaper/aera/releases).

### Windows

Windows SmartScreen puede mostrarse cuando una compilación no está firmada. Continúa únicamente si el archivo proviene de la página de Releases de Aera.

### Linux

Los paquetes usan el prefijo `Aera`.

```bash
sudo dnf install ./Aera-<version>.rpm
```

## Cómo funciona

En el primer inicio, Aera permite elegir un Aera Runtime local o remoto:

1. El modo local detecta un Runtime existente y ofrece instalarlo cuando sea necesario.
2. Los modos remoto y SSH validan el destino sin instalar un Runtime local.
3. Los proveedores y modelos se configuran desde la interfaz.
4. El workspace se abre cuando el Runtime seleccionado está listo.

Aera Runtime conserva las rutas y comandos de compatibilidad:

- `~/.hermes`
- `~/.hermes/.env`
- `~/.hermes/config.yaml`
- `~/.hermes/hermes-agent`
- `HERMES_HOME` y las demás variables `HERMES_*`
- el comando `hermes`

Estos identificadores permanecen estables para que instalaciones, perfiles, scripts y datos existentes sigan funcionando después del cambio de marca.

## Desarrollo

```bash
npm ci
npm run dev
```

Verificación:

```bash
npm test
npm run typecheck
npm run build
```

## Licencia

Aera se distribuye bajo la [MIT License](LICENSE).
