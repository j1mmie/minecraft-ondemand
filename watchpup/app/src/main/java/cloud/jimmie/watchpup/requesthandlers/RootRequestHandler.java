package cloud.jimmie.watchpup.requesthandlers;

import java.io.IOException;
import java.io.OutputStream;

import org.bukkit.Bukkit;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

public class RootRequestHandler implements HttpHandler {
  public boolean hideTrueCount;

  public RootRequestHandler(boolean hideTrueCount) {
    this.hideTrueCount = hideTrueCount;
  }

  private String getResponse() {
    int playerCount = Bukkit.getServer().getOnlinePlayers().size();

    if (this.hideTrueCount) {
      return playerCount > 0 ? "1" : "0";
    }

    return Integer.toString(playerCount);
  }

  @Override
  public void handle(HttpExchange t) throws IOException {
    String response = this.getResponse();
    t.sendResponseHeaders(200, response.length());

    OutputStream os = t.getResponseBody();
    os.write(response.getBytes());
    os.close();
  }
}

