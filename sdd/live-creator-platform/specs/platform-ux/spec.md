# Spec: platform-ux - Experiencia transversal de plataforma

## Proposito

Dar contrato verificable a PH-01...PH-07: sistema visual, landing, navegacion, estados, emails y operacion tablet. No reemplaza las paginas funcionales de cada capability.

## Comportamiento observable

### Requirement: Sistema y navegacion coherentes

La app MUST usar tokens compartidos de color, tipografia, espaciado y estados; la navegacion debe exponer solo superficies habilitadas para el tenant/rol y ofrecer estados vacio, carga y error accesibles.

#### Scenario: Tenant sin feature
- GIVEN una capability deshabilitada
- WHEN el usuario inicia sesion
- THEN no ve la navegacion ni puede abrir la ruta; recibe una explicacion de acceso cuando corresponde

### Requirement: Landing y comunicaciones de producto

La landing publica MUST presentar propuesta, planes y demo sin depender de sesion. Los emails transaccionales MUST usar la marca de plataforma y ser legibles en clientes comunes.

#### Scenario: Email de trial
- GIVEN un trial proximo a vencer
- WHEN se encola su email
- THEN incluye branding, limite/fecha correctos y enlace seguro a facturacion

### Requirement: Operacion en tablet

La sala en vivo y la bandeja MUST conservar acciones principales y legibilidad en viewport tablet; no se exige edicion completa de video movil.

#### Scenario: Produccion usa la sala en tablet
- GIVEN viewport de 768 px
- WHEN llega una actualizacion de timeline
- THEN timeline, mark manual y correccion de persona siguen operables sin scroll horizontal critico

## Trazabilidad

PH-01...PH-07. Implementado por T-60 y complementado por T-55, T-59 y T-65.
