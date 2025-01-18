package cloud.jimmie.watchpup;

import java.io.File;
import java.util.logging.Logger;

import javax.annotation.Nullable;

import org.bukkit.plugin.PluginDescriptionFile;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.java.JavaPluginLoader;

import cloud.jimmie.watchpup.bstats.Metrics;

public class Plugin extends JavaPlugin {
  public final static int BSTATS_PLUGIN_ID = 24489;

  @Nullable
  public ServerManager serverManager;

  public Plugin() {
    super();
  }

  protected Plugin(JavaPluginLoader loader, PluginDescriptionFile description, File dataFolder, File file) {
    super(loader, description, dataFolder, file);
  }

  @Override
  public void onEnable() {
    Logger logger = getLogger();
    logger.info("Plugin: Enabling");

    new Metrics(this, BSTATS_PLUGIN_ID);
    this.serverManager = new ServerManager(this, logger);
  }

  @Override
  public void onDisable() {
    if (this.serverManager != null) {
      this.serverManager.shutdown();
    }

    getLogger().info("Plugin: Disabling.");
  }
}