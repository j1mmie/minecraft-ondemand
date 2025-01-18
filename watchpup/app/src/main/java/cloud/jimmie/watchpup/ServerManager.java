package cloud.jimmie.watchpup;

import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.logging.Logger;

import javax.annotation.Nonnull;

import org.bukkit.configuration.file.FileConfiguration;

import com.sun.net.httpserver.HttpServer;

import cloud.jimmie.watchpup.requesthandlers.RootRequestHandler;

public class ServerManager {
  @Nonnull
  public File configFile;

  @Nonnull
  public FileConfiguration config;

  @Nonnull
  public HttpServer server;

  @Nonnull
  public Logger log;

  public int httpPort;

  public ServerManager(@Nonnull Plugin plugin, @Nonnull Logger logger) {
    this.log = logger;

    this.log.info("ServerManager: Loading config from " + plugin.getDataFolder().getAbsolutePath() + "/config.yml");

    plugin.saveDefaultConfig();

    this.config = plugin.getConfig();
    this.config.addDefault("port",            57475);
    this.config.addDefault("hide_true_count", false);

    this.httpPort = this.config.getInt("port");

    this.log.info("ServerManager: Config loaded.");

    this.startHttpServer();
  }

  private void startHttpServer() {
    this.log.info("ServerManager: Starting HTTP server on port %d...".formatted(this.httpPort));

    try {
      this.server = HttpServer.create(new InetSocketAddress(this.httpPort), 0);
    } catch (IOException e) {
      e.printStackTrace();
      return;
    }

    var requestHandler = new RootRequestHandler(
      this.config.getBoolean("hide_true_count")
    );

    server.createContext("/", requestHandler);
    server.setExecutor(null);
    server.start();

    log.info("ServerManager: HTTP server started.");
  }

  public void shutdown() {
    log.info("ServerManager: Shutting down HTTP server...");
    server.stop(0);
    log.info("ServerManager: HTTP server stopped.");
  }
}
