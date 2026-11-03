/**
 * Server Main
 * Entry point of the SessionHistoryServer: initializes the system-installed
 * GStreamer, self-tests the required GStreamer elements and the native TEN
 * VAD library, warms up the processor discovery, the GraalVM script engine
 * and the WebRTC ingest path, then starts the embedded Jetty server with
 * the session servlets and websocket endpoint.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory;

import dk.cavi.sessionhistory.auth.EntityAuthFilter;
import dk.cavi.sessionhistory.auth.TokenStore;
import dk.cavi.sessionhistory.core.ClassFinder;
import dk.cavi.sessionhistory.core.Core;
import dk.cavi.sessionhistory.core.Health;
import dk.cavi.sessionhistory.core.ServerConfig;
import dk.cavi.sessionhistory.domain.EntityIngestPipeline;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.processors.Processor;
import dk.cavi.sessionhistory.domain.processors.ScriptProcessor;
import dk.cavi.sessionhistory.endpoints.HealthServlet;
import dk.cavi.sessionhistory.endpoints.LoginServlet;
import dk.cavi.sessionhistory.endpoints.SessionManager;
import dk.cavi.sessionhistory.endpoints.WebsocketEndpoint;
import dk.cavi.sessionhistory.interoperability.TenVAD;
import jakarta.servlet.DispatcherType;
import jakarta.websocket.server.ServerContainer;
import java.io.IOException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.logging.ConsoleHandler;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.FilterMapping;
import org.eclipse.jetty.ee10.servlet.ServletHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;

import org.eclipse.jetty.ee10.webapp.WebAppContext;
import org.eclipse.jetty.ee10.websocket.jakarta.server.config.JakartaWebSocketServletContainerInitializer;
import org.eclipse.jetty.http.UriCompliance;
import org.eclipse.jetty.server.Connector;
import org.eclipse.jetty.server.HttpConnectionFactory;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.util.resource.Resource;
import org.eclipse.jetty.util.resource.ResourceFactory;
import org.freedesktop.gstreamer.Element;
import org.freedesktop.gstreamer.ElementFactory;
import org.freedesktop.gstreamer.Gst;
import org.freedesktop.gstreamer.Registry;
import org.freedesktop.gstreamer.lowlevel.MainLoop;

/**
 *
 * @author jbk
 */
public class Main {
    private static final Logger LOGGER = Logger.getLogger(Main.class.getName());

    public static void main(String[] args) throws IOException, InterruptedException {
        configureLogging();
        try {
            // Recorded sessions live under the sessions base directory (the
            // session.basePath property, "sessions" by default). 
            Path sessionBaseDir = SessionStorage.getSessionBaseDir().toPath();
            LOGGER.config("Sessions base directory is " + sessionBaseDir.toAbsolutePath());
            if (!Files.isDirectory(sessionBaseDir)) {
                LOGGER.severe("The sessions base directory " + sessionBaseDir.toAbsolutePath() + " does not exist (or is not a directory) - create it or point -Dsession.basePath at an existing writable directory");
                System.exit(-23);
            }
            try {
                Path probe = Files.createTempFile(sessionBaseDir, "shs-write-check-", ".tmp");
                probe.toFile().delete();
                Health.noteSessionDirWritable(true);
                Health.refreshSessionDirState(); // prime the usable-space observation
            } catch (IOException e) {
                Health.noteSessionDirWritable(false);
                LOGGER.severe("The sessions base directory " + sessionBaseDir.toAbsolutePath() + " is not writable - fix the permissions or point -Dsession.basePath at a writable directory");
                System.exit(-23);
            }

            // Entity tokens (the auth layer): one JSON file per entityKey
            // under the tokens base directory (auth.tokenPath, "tokens" by
            // default), created here, swept of expired files, and probed
            // for writability like the sessions base directory.
            Path tokenDir = null;
            try {
                tokenDir = TokenStore.init();
                Health.noteTokensDirWritable(true);
                LOGGER.config("Tokens directory is " + tokenDir.toAbsolutePath());
            } catch (IOException e) {
                Health.noteTokensDirWritable(false);
                LOGGER.log(Level.SEVERE, "The tokens directory could not be created or is not writable - fix the permissions or point auth.tokenPath in config.json at a writable directory", e);
                System.exit(-23);
            }

            // Fail closed, loudly: without a master password no entityKey can
            // ever be minted, so every /session request will be rejected.
            ServerConfig.AuthConfig authConfig = Core.getServerConfig().auth;
            boolean authConfigured = authConfig != null && authConfig.masterPassword != null && !authConfig.masterPassword.isBlank();
            Health.noteAuthConfigured(authConfigured);
            if (!authConfigured) {
                LOGGER.warning("No auth.masterPassword is configured in config.json - nobody can log in, so every session request will be rejected until one is set. Example: {\"auth\": {\"masterPassword\": \"<a secret>\"}} - see the README.");
            }

            LOGGER.info("Starting GStreamer initialization (expecting a system installation)");
            System.setProperty("gstreamer.suppressVersionChecks", "true");
            try {
                Gst.init("", new String[]{"--gst-disable-registry-fork", "--gst-disable-segtrap"});
                Health.noteGStreamerInitialized(true);
            } catch (Throwable t) {
                Health.noteGStreamerInitialized(false);
                LOGGER.log(Level.SEVERE, "GStreamer could not be initialized - install it as described in the 'Native installation' section of the README", t);
                System.exit(-23);
            }
            final MainLoop loop = new MainLoop();

            LOGGER.config("GStreamer is version " + Gst.getVersion().getMajor() + "." + Gst.getVersion().getMinor());
            Registry.get().getPluginList().stream()
                .collect(java.util.stream.Collectors.groupingBy(
                    plug -> plug.getPackage(),
                    java.util.TreeMap::new,
                    java.util.stream.Collectors.mapping(
                        plug -> plug.getName() + " (" + plug.getVersion() + ")",
                        java.util.stream.Collectors.collectingAndThen(
                            java.util.stream.Collectors.toList(),
                            list -> {
                                java.util.Collections.sort(list);
                                return String.join(", ", list);
                            }
                        )
                    )
                ))
                .forEach((pkg, plugins) -> LOGGER.config(pkg + ": " + plugins));
            LOGGER.info("Performing self-tests...");
            // Besides the static pipeline elements, preflight the elements
            // that are only created DYNAMICALLY once a browser connects:
            // webrtcbin spawns its per-connection ICE agents (nicesink/
            // nicesrc), DTLS (dtlsenc/dtlsdec/dtlssrtpenc), SRTP (srtpenc/
            // srtpdec), SCTP data channels (sctpenc/sctpdec) and one
            // rtpsession per incoming stream (its internal rtpbin), while
            // the ingest pipeline itself creates an rtp<codec>depay per
            // incoming stream (named after the browser's negotiated codec,
            // so only the common VP8/Opus ones can be preflighted), and the
            // voice activation processor needs audioresample. Checking one
            // element per plugin is enough - the plugin ships the family.
            String[] requiredElements = {"webrtcbin", "nicesink", "queue", "capsfilter", "matroskamux", "appsink", "appsrc", "decodebin", "capssetter", "videorate", "jpegenc", "identity", "audioconvert", "audiobuffersplit", "wavenc",
                "sctpenc", "dtlsenc", "srtpenc", "rtpsession", "rtpvp8depay", "rtpopusdepay", "audioresample"};
            // Which package each element ships in (used for self-test hints)
            java.util.Map<String, String> elementPackage = java.util.Map.ofEntries(
                java.util.Map.entry("webrtcbin", "gst-plugins-bad"),
                java.util.Map.entry("nicesink", "the libnice plugin (Debian/Ubuntu package gstreamer1.0-nice)"),
                java.util.Map.entry("identity", "the GStreamer core"),
                java.util.Map.entry("matroskamux", "gst-plugins-good"),
                java.util.Map.entry("jpegenc", "gst-plugins-good"),
                java.util.Map.entry("audiobuffersplit", "gst-plugins-good"),
                java.util.Map.entry("wavenc", "gst-plugins-good"),
                java.util.Map.entry("sctpenc", "gst-plugins-bad"),
                java.util.Map.entry("dtlsenc", "gst-plugins-bad"),
                java.util.Map.entry("srtpenc", "gst-plugins-bad"),
                java.util.Map.entry("rtpsession", "gst-plugins-good"),
                java.util.Map.entry("rtpvp8depay", "gst-plugins-good"),
                java.util.Map.entry("rtpopusdepay", "gst-plugins-good"),
                java.util.Map.entry("audioresample", "gst-plugins-base")
            );
            boolean selfTest = true;
            for (String elementName : requiredElements) {
                try {
                    Element element = ElementFactory.make(elementName, elementName);
                    if (element == null) {
                        throw new Exception("Failed to create element");
                    }
                    element.disown();
                    LOGGER.info("Self-test " + elementName + ": OK");
                } catch (Exception e) {
                    LOGGER.log(Level.SEVERE, "Self-test " + elementName + ": missing GStreamer element, usually shipped in "
                            + elementPackage.getOrDefault(elementName, "gst-plugins-base")
                            + " (see README: Native installation)", e);
                    selfTest = false;
                }
            }

            boolean tenVadOk = true;
            try {
                TenVAD tenVAD = new TenVAD(512, 0.5f);
                tenVAD.destroy();
                LOGGER.info("Self-test TEN Voice Activation Detector: OK");
            } catch (Throwable e) {
                LOGGER.log(Level.SEVERE, "Self-test TEN Voice Activation Detector: libten_vad not loadable - install the TEN VAD SDK and put libten_vad on the library path (see README: Native installation)", e);
                tenVadOk = false;
                selfTest = false;
            }
            Health.noteTenVadLoaded(tenVadOk);
            Health.noteSelfTestPassed(selfTest);

            if (!selfTest){
                LOGGER.severe("Failed self-tests - install the missing components as described in the 'Native installation' section of the README");
                System.exit(-23);
            }

            // Warm-up: pay the one-time costs here at boot 
            long warmupStart = System.currentTimeMillis();            
            LOGGER.config("Supported processors: " + String.join(", ", ClassFinder.singleton().findSubclasses(Processor.class).stream().map(Class::getName).collect(java.util.stream.Collectors.toList())));
            ScriptProcessor.warmup();
            EntityIngestPipeline.warmup();
            Health.noteWarmupCompleted(true);
            LOGGER.info("Warm-up completed in " + (System.currentTimeMillis() - warmupStart) + "ms");

            int port = Integer.parseInt(System.getProperty("jetty.port", "3001"));
            Server server = new Server(port);

            // Pin the connector's URI compliance: DEFAULT
            // allows zero URI violations, so %2F separators, encoded dot
            // segments, %25, empty segments, suspicious characters and bad
            // UTF-8 are all rejected with a 400 before any servlet or
            // websocket endpoint sees the path.
            for (Connector connector : server.getConnectors()) {
                HttpConnectionFactory http = connector.getConnectionFactory(HttpConnectionFactory.class);
                if (http != null) http.getHttpConfiguration().setUriCompliance(UriCompliance.DEFAULT);
            }
            WebAppContext context = new WebAppContext();
            context.setContextPath(System.getProperty("context", "/"));

            Resource baseResource = findBaseResource(context);
            context.setBaseResource(baseResource);
            context.setParentLoaderPriority(true);
            context.setAttribute("org.eclipse.jetty.server.webapp.ContainerIncludeJarPattern", ".*.jar|.*/*.jar|.*/classes/.*");
            
            // Add basic files
            context.setWelcomeFiles(new String[]{"index.html"});
            
            // Basic servlets
            ServletHolder sessionManagerHolder = new ServletHolder(SessionManager.class);
            context.addServlet(sessionManagerHolder, "/session");

            // The auth gate: /login mints entityKeys (proving ownership of
            // an entity id), and the EntityAuthFilter below demands one on
            // everything under /session — HTTP requests and websocket
            // upgrades alike, since Jetty runs the websocket upgrade
            // through the servlet filter chain.
            ServletHolder loginHolder = new ServletHolder(LoginServlet.class);
            context.addServlet(loginHolder, "/login");

            // The health report for Zabbix and other uptime monitors: reads
            // back the booleans Health maintains (no per-request file-system
            // or lock work), so polling cannot burden the server. Unauthenticated
            // by design — it exposes no session data, only machine state.
            ServletHolder healthHolder = new ServletHolder(HealthServlet.class);
            context.addServlet(healthHolder, "/health");

            // The auth filter must veto websocket handshakes BEFORE they
            // are upgraded. Jetty's WebSocketUpgradeFilter prepends ITSELF
            // to the front of the filter chain while the websocket
            // initializer below runs (it uses ServletHandler's prepend
            // methods itself), so a plain context.addFilter could never get
            // in front of it. This holder is therefore registered from
            // inside that initializer — right after the upgrade filter has
            // prepended itself, and still before the servlet handler
            // starts — by prepending it in turn. The check after
            // server.start() fails closed if that registration ever did
            // not happen.
            FilterHolder authFilterHolder = new FilterHolder(EntityAuthFilter.class);
            authFilterHolder.setName(EntityAuthFilter.class.getName());

            // Websockets
            JakartaWebSocketServletContainerInitializer.configure(context, (servletContext, container) -> {
                try {
                    ServerContainer serverContainer = (ServerContainer) container;

                    // ahead of the websocket upgrade filter (see above)
                    ServletHandler servletHandler = context.getServletHandler();
                    FilterMapping authFilterMapping = new FilterMapping();
                    authFilterMapping.setFilterName(authFilterHolder.getName());
                    authFilterMapping.setPathSpec("/session/*");
                    authFilterMapping.setDispatcherTypes(EnumSet.of(DispatcherType.REQUEST));
                    servletHandler.prependFilter(authFilterHolder);
                    servletHandler.prependFilterMapping(authFilterMapping);

                    // Register your annotated class directly
                    serverContainer.addEndpoint(WebsocketEndpoint.class);
                } catch (Exception e) {
                    LOGGER.log(Level.SEVERE, "Failed to register the websocket endpoint or the auth filter", e);
                }
            });

            server.setHandler(context);

            // Start the server
            server.start();

            // Fail closed: without the auth filter in the chain the service
            // would come up unprotected (it is registered from the
            // websocket initializer above, so an initializer problem would
            // take it down with it — never leave /session unguarded).
            boolean authFilterMapped = false;
            for (FilterMapping mapping : context.getServletHandler().getFilterMappings()) {
                if (authFilterHolder.getName().equals(mapping.getFilterName())) {
                    authFilterMapped = true;
                    break;
                }
            }
            if (!authFilterMapped) {
                LOGGER.severe("The auth filter was not registered on /session/* - refusing to start unprotected");
                System.exit(-23);
            }

            // The server is up and fully checked: stamp the uptime origin
            // and let the slow background refresh keep the session-directory
            // observations truthful during idle stretches.
            Health.noteStarted();
            Health.startBackgroundRefresh();

            server.join();
            
        } catch (Exception e) {
            LOGGER.log(Level.SEVERE, "SessionHistoryServer failed", e);
        }
    }

    /**
     * All logging — the application's own loggers, Jetty's (through the
     * slf4j-jdk14 binding) and the libraries' — goes through
     * java.util.logging, installed here before anything logs, with a
     * single-line "2025-05-18 10:42:17 INFO    message" format. The default
     * INFO level can be changed with -Dlog.level=FINE (or any other
     * java.util.logging.Level name).
     */
    private static void configureLogging() {
        System.setProperty("java.util.logging.SimpleFormatter.format",
                "%1$tF %1$tT %4$-7s %5$s%6$s%n");
        Logger rootLogger = Logger.getLogger("");
        for (Handler handler : rootLogger.getHandlers()) {
            rootLogger.removeHandler(handler);
        }
        ConsoleHandler consoleHandler = new ConsoleHandler();
        consoleHandler.setLevel(Level.ALL);
        rootLogger.addHandler(consoleHandler);

        Level rootLevel = Level.INFO;
        String levelName = System.getProperty("log.level");
        if (levelName != null) {
            try {
                rootLevel = Level.parse(levelName);
            } catch (IllegalArgumentException ex) {
                LOGGER.warning("Unknown -Dlog.level value '" + levelName + "', staying at INFO");
            }
        }
        rootLogger.setLevel(rootLevel);
    }
    
    private static Resource findBaseResource(WebAppContext context) {
        ResourceFactory resourceFactory = ResourceFactory.of(context);

        // Look for resource in classpath (this is the best choice when working with a jar/war archive)
        LOGGER.fine("Locating the webapp resource base");

        // Look for resource in common file system paths
        try {
            Path pwd = Path.of(System.getProperty("user.dir")).toAbsolutePath();

            // Try the source path next
            Path srcWebapp = pwd.resolve("src/main/webapp/");
            if (Files.exists(srcWebapp)) {
                LOGGER.fine("Using webapp resource base (src/main/webapp): " + srcWebapp);
                return resourceFactory.newResource(srcWebapp);
            }
            
            URL webXml = Main.class.getClassLoader().getResource("webapp");
            if (webXml != null) {
                LOGGER.fine("Using webapp resource base (classpath): " + webXml);
                return resourceFactory.newResource(webXml);
            }            
        } catch (Throwable t) {
            throw new RuntimeException("Unable to find web resource in file system", t);
        }

        throw new RuntimeException("Unable to find web resource ref");
    }    
}