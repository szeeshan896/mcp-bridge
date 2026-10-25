# MCP Manager

Spring Boot starter project — Java 21, Maven.

## Stack

| | |
|---|---|
| Java | 21 |
| Spring Boot | 4.1.2 |
| Build | Maven (wrapper included) |

Dependencies are intentionally minimal: `spring-boot-starter-web` and
`spring-boot-starter-test`. No database, no business logic yet.

## Run

```bash
./mvnw spring-boot:run
```

Starts on http://localhost:8080. There are no endpoints yet, so the app
just boots and waits.

## Test

```bash
./mvnw test
```

## Package

```bash
./mvnw clean package
java -jar target/mcp-manager-0.0.1-SNAPSHOT.jar
```

## Layout

```
src/main/java/com/szeeshan/mcpmanager/McpManagerApplication.java   entry point
src/main/resources/application.properties                         config
src/test/java/com/szeeshan/mcpmanager/McpManagerApplicationTests   context-load test
```

## Notes

- Group ID is `com.szeeshan` and the base package is
  `com.szeeshan.mcpmanager` — change both together if you want a different one.
- `spring-boot-starter-web` is included so the app boots an HTTP server.
  Drop it from `pom.xml` if you want a plain non-web application.
