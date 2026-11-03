/**
 * Entity Ingest Pipeline
 * GStreamer pipeline terminating one entity's WebRTC ingest connection:
 * negotiates SDP and ICE over the websocket, records incoming media streams
 * into Matroska tracks, and appends data channel events to event tracks.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain;

import java.net.URI;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.freedesktop.gstreamer.Caps;
import org.freedesktop.gstreamer.Element;
import org.freedesktop.gstreamer.ElementFactory;
import org.freedesktop.gstreamer.GstObject;
import org.freedesktop.gstreamer.Pad;
import org.freedesktop.gstreamer.SDPMessage;
import org.freedesktop.gstreamer.Structure;
import org.freedesktop.gstreamer.elements.AppSink;
import org.freedesktop.gstreamer.glib.Natives;
import org.freedesktop.gstreamer.lowlevel.GstAPI;
import org.freedesktop.gstreamer.webrtc.WebRTCBin;
import org.freedesktop.gstreamer.webrtc.WebRTCDataChannel;
import org.freedesktop.gstreamer.webrtc.WebRTCSDPType;
import org.freedesktop.gstreamer.webrtc.WebRTCSessionDescription;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.jna.ptr.PointerByReference;

import dk.cavi.sessionhistory.api_datachannel.StartEventStream;
import dk.cavi.sessionhistory.api_datachannel.StartMediaStream;
import dk.cavi.sessionhistory.api_websocket.ICECandidate;
import dk.cavi.sessionhistory.api_websocket.SDPAnswer;
import dk.cavi.sessionhistory.api_websocket.SDPOffer;
import dk.cavi.sessionhistory.core.Core;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.processors.DefaultProcessingPipeline;
import dk.cavi.sessionhistory.domain.tracks.AbstractEventTrack.JSONAppender;
import dk.cavi.sessionhistory.domain.tracks.IngestEventTrack;
import dk.cavi.sessionhistory.domain.tracks.IngestMediaTrack;
import dk.cavi.sessionhistory.endpoints.WebsocketEndpoint;

import java.io.IOException;
import java.util.List;
import org.freedesktop.gstreamer.State;
import org.freedesktop.gstreamer.event.EOSEvent;
import org.freedesktop.gstreamer.glib.GObject;
import org.freedesktop.gstreamer.webrtc.WebRTCICE;

/**
 *
 * @author jbk
 */
public class EntityIngestPipeline {
    private static final Logger LOGGER = Logger.getLogger(EntityIngestPipeline.class.getName());
    private final DefaultProcessingPipeline pipeline;
    private final WebRTCBin webrtc;
    private final WebsocketEndpoint socket;
    private final Map<String,StartMediaStream> midStreamMap = new HashMap<>();
    private final Map<String,StartEventStream> eventStreamMap = new HashMap<>();

    /** Op counter of the requestIngestNegotiation command this pipeline
     *  replies to (captured from the constructor's SDPOffer). */
    private final int negotiationOp;

    /** The server-initiated base data channel. Created (idempotently, see
     *  {@link #ensureBaseChannel}) BEFORE the first offer is generated, so
     *  the initial offer always carries its m=application section. */
    private WebRTCDataChannel baseChannel;
    private volatile boolean baseChannelWired;

    /** Initial-offer state machine (all transitions happen on webrtcbin's
     *  negotiation threads; volatile for cross-thread visibility into the
     *  createOffer callback):
     *  <ul>
     *   <li>{@code initialOfferSent} — the reply went out; a need after
     *       this point can no longer be folded into the initial offer.</li>
     *   <li>{@code initialOfferInFlight} — createOffer() was issued but the
     *       reply has not been sent; a need arriving now is remembered in
     *       {@code pendingInitialRenegotiation} and folded in by
     *       regenerating the offer.</li>
     *  </ul> */
    private volatile boolean initialOfferSent;
    private volatile boolean initialOfferInFlight;
    private volatile boolean pendingInitialRenegotiation;

    /** How many times the initial offer may be regenerated (folding in a
     *  follow-up need, or retrying after an incomplete offer) before the
     *  client gets a fast, descriptive failure instead of a dead offer. */
    private static final int MAX_INITIAL_OFFER_ATTEMPTS = 4;

    /** Codecs that go from the depayloader straight to the muxer with no
     *  bitstream parser in between - the depayloaders already hand the
     *  muxer complete, muxable frames for these. (vp8 video; opus instead
     *  gets a rate-pinning capsfilter in padAdded.) */
    private static final List<String> PARSERLESS_CODECS = List.of("vp8", "opus");

    /**
     * Create a GStreamer element, failing loudly - and descriptively - when
     * its factory is not installed. gst1-java-core signals a missing
     * factory by throwing IllegalArgumentException ("No such Gstreamer
     * factory: ...") from ElementFactory.make; the old pad-added handler
     * swallowed that after printing a stack trace, leaving the stream silently
     * unrecorded. The null check below is defense in depth for bindings
     * that return null instead. Either way the message names the element,
     * what it was needed for and where it usually ships, and goes back to
     * the browser through the pad-added error report.
     * @param factoryName the element factory to instantiate
     * @param elementName the name for the created element
     * @param purpose what the element is needed for, and where it usually
     * ships - goes into the error sent back to the browser
     * @return the created element, never null
     */
    private static Element makeChecked(String factoryName, String elementName, String purpose) {
        Element element;
        try {
            element = ElementFactory.make(factoryName, elementName);
        } catch (IllegalArgumentException ex) {
            throw new IllegalStateException("GStreamer element '"+factoryName+"' ("+purpose+") is not available: "+ex.getMessage(), ex);
        }
        if (element == null) {
            throw new IllegalStateException("GStreamer element '"+factoryName+"' ("+purpose+") is not available - missing plugin?");
        }
        return element;
    }

    /** TURN and turns:// URIs embed user:password credentials - never log
     * them raw; reduce an ICE server URI to scheme://host[:port]. */
    private static String iceServerForLog(String iceServer) {
        try {
            URI uri = URI.create(iceServer);
            if (uri.getHost() != null) {
                return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() >= 0 ? ":" + uri.getPort() : "");
            }
        } catch (IllegalArgumentException malformed) {
            // fall through and log a placeholder instead of a malformed URI
        }
        return "(unparsed ICE server URI)";
    }

    public void destroy() {
        LOGGER.fine("Destroying webrtc pads");
        webrtc.getSrcPads().forEach(pad->{
            // STUB: This isn't working! FIXME
            if (pad.isLinked()){
                pad.getPeer().sendEvent(new EOSEvent());
                LOGGER.fine("Sending EOS to webrtc pad "+pad.getName());
            } else {
                LOGGER.fine("Webrtc pad "+pad.getName()+" is not linked");
            }
            
        });

        try {
            // STUB: Hardcoded 2s shutdown delay for WebRTC peer pads to flush
            Thread.sleep(2000);
        } catch (InterruptedException ex){
            LOGGER.log(Level.WARNING, "The WebRTC peer pad flush delay was interrupted", ex);
        }

        LOGGER.info("Destroying pipeline: "+ pipeline.setState(State.NULL));
        pipeline.dispose();
    }

    /**
     * Boot-time warm-up: runs one throwaway ingest negotiation - pipeline,
     * webrtcbin, base data channel and the offer with its DTLS certificate -
     * so the first real client does not pay the one-time construction and
     * certificate-generation costs. The warm-up pipeline is fully disposed
     * again before the server starts serving.
     */
    public static void warmup() {
        try {
            DefaultProcessingPipeline warmupPipeline = new DefaultProcessingPipeline("Warmup", "shs-warmup");
            WebRTCBin warmupWebrtc = new WebRTCBin("shs-warmup-webrtc");
            CountDownLatch offerDone = new CountDownLatch(1);
            warmupWebrtc.connect(new WebRTCBin.ON_NEGOTIATION_NEEDED() {
                private boolean offerRequested;
                @Override
                public void onNegotiationNeeded(Element element) {
                    if (offerRequested) return; // a second negotiation-needed during warm-up is not ours to serve
                    offerRequested = true;
                    // The warm-up offer must carry the data channel, or it
                    // warms nothing (no m=application → no SCTP/DTLS
                    // transports → no certificate generation). Same ordering
                    // as the real pipeline: channel BEFORE createOffer.
                    PointerByReference warmupChannel = new PointerByReference();
                    warmupWebrtc.emit("create-data-channel", "__historybasechannel", null, warmupChannel);
                    Natives.objectFor(warmupChannel.getValue(), WebRTCDataChannel.class, false, true);
                    warmupWebrtc.createOffer(new WebRTCBin.CREATE_OFFER() {
                        @Override
                        public void onOfferCreated(WebRTCSessionDescription offer) {
                            offer.disown(); // generating this offer is what warms the DTLS certificate
                            offerDone.countDown();
                        }
                    });
                }
            });
            warmupPipeline.add(warmupWebrtc);
            warmupPipeline.play();
            if (!offerDone.await(30, TimeUnit.SECONDS)) {
                LOGGER.warning("Ingest warm-up timed out waiting for the offer");
            }
            warmupPipeline.setState(State.NULL);
            warmupPipeline.dispose();
        } catch (Throwable t) {
            LOGGER.log(Level.WARNING, "Ingest warm-up failed, the first client will pay the cold cost", t);
        }
    }

    interface TransceiverAdded extends GstAPI.GstCallback {
        public void callback(Element element, GstObject object, Integer data);
    }    
    interface OnDataChannel extends GstAPI.GstCallback {
        public void callback(Element element, WebRTCDataChannel object, Integer data);
    }        
    
    
    public EntityIngestPipeline(WebsocketEndpoint socket, SDPOffer initialSDPOffer){       
        String name = socket.getHistoryStorageSession().getId()+"-"+socket.getEntityId();
        this.socket = socket;        
        pipeline = new DefaultProcessingPipeline("EntityIngest", name);

        // Setup WebRTCEndpoint
        webrtc = new WebRTCBin(name+"-webrtc");
        webrtc.set("bundle-policy", 2); // MAX compat bundling for dynamic add/remove of streams
        webrtc.set("latency", 100); // only add 100ms of jitterbuffer
        WebRTCICE ice = (WebRTCICE) webrtc.get("ice-agent");
        ice.set("min-rtp-port", Core.getServerConfig().webrtc.minRTPPort);
        ice.set("max-rtp-port", Core.getServerConfig().webrtc.maxRTPPort);
        
        // ICE server configuration: STUN is
        // configured through the single stun-server property and exactly ONE
        // stun:// entry can be honored — extras are skipped with a warning
        // (use TURN for redundancy). TURN servers use the add-turn-server
        // action signal, which supports any number of turn:// and turns://
        // (TURN over TLS) entries; a turn:// entry may carry ?transport=tcp
        // (or ?transport=udp) to pin the relay transport — without a
        // transport query both are configured.
        boolean stunConfigured = false;
        for (String iceServer : Core.getServerConfig().webrtc.iceServers){
            if (iceServer.startsWith("stun://")){
                if (stunConfigured){
                    LOGGER.warning("webrtcbin supports only one STUN server; ignoring "+iceServer+" (one is already configured - use TURN for redundancy)");
                } else {
                    LOGGER.fine("Adding STUN server "+iceServer);
                    webrtc.set("stun-server", iceServer);
                    stunConfigured = true;
                }
            } else if (iceServer.startsWith("turn://") || iceServer.startsWith("turns://")){
                // The add-turn-server action signal answers with a gboolean
                // (TRUE = URI accepted). Collecting it through a trailing
                // holder follows the create-data-channel idiom below; emitting
                // without the holder makes GLib log a critical per call.
                int[] turnAccepted = { 0 };
                webrtc.emit("add-turn-server", iceServer, turnAccepted);
                if (turnAccepted[0] != 0){
                    LOGGER.fine("Adding TURN server "+iceServerForLog(iceServer));
                } else {
                    LOGGER.warning("TURN server was rejected (expected turn://user:password@host:port or turns://..., optionally ?transport=tcp|udp): "+iceServerForLog(iceServer));
                }
            } else {
                LOGGER.warning("Unsupported ICE server URI "+iceServerForLog(iceServer)+" (expected stun://, turn:// or turns://); ignoring it");
            }
        }

        EntityIngestPipeline.TransceiverAdded transceiverAdded = (element, object, data) -> {
            object.set("do-nack", true);
            LOGGER.fine("Transceiver added: mlineindex "+object.get("mlineindex")+", mid "+object.get("mid"));
            
        };
        webrtc.connect("on-new-transceiver", EntityIngestPipeline.TransceiverAdded.class, transceiverAdded, transceiverAdded);
        
        EntityIngestPipeline.OnDataChannel dataChannelHandler = (element, webRTCChannel, data) -> {
            LOGGER.fine("Datachannel added: "+webRTCChannel.getLabel());

            // Set up json writer resource
            try {
                StartEventStream info = eventStreamMap.get(webRTCChannel.getLabel());
                if (info==null) throw new IllegalArgumentException("Cannot find registration for "+webRTCChannel.getLabel());            
                IngestEventTrack track = new IngestEventTrack(socket.getHistoryStorageSession(), socket.getHistoryStorageSession().createEventId(), socket.getEntityId(), socket.getConnectionId(), info);
                JSONAppender jsonAppender = track.connectJSONAppender();
                track.saveConfig();
                Gson trackGson = new Gson();
                Map<String, String> clientToSessionIdMap = new HashMap<>();
                webRTCChannel.connect((WebRTCDataChannel.ON_MESSAGE_STRING)(channel, message) -> {
                    // Parse message and validate it against session schema
                    TimedEvent event = trackGson.fromJson(message, TimedEvent.class);
                    event.created = System.currentTimeMillis();
                    if (event.id != null) {
                        // TODO: If this is a non-tentative event with a mapping, clear it from the map to save memory

                        // Need to map this event from client space (big UUIDs) to session space (forthgoing small ids)
                        String existingMapping = clientToSessionIdMap.get(event.id);
                        if (existingMapping==null){
                            existingMapping = socket.getHistoryStorageSession().createEventId();
                            clientToSessionIdMap.put(event.id, existingMapping);
                        }
                        event.id = existingMapping;
                    } else {
                        event.id = socket.getHistoryStorageSession().createEventId();
                    }
                    // TODO: Validate data against session schema

                    // Append message to log
                    try {
                        jsonAppender.append((JsonObject) trackGson.toJsonTree(event));
                    } catch (Throwable ex){
                        LOGGER.log(Level.WARNING, "Failed to append an event to the ingest event track", ex);
                    }
                });
                webRTCChannel.connect(new WebRTCDataChannel.ON_CLOSE() {
                    @Override
                    public void onClose(WebRTCDataChannel channel) {
                        try {
                            jsonAppender.close();
                        } catch (IOException e) {
                            LOGGER.log(Level.WARNING, "Failed to close the ingest event track JSON appender", e);
                        }
                    }
                    
                });
            } catch (Throwable ex){
                LOGGER.log(Level.WARNING, "Failed to set up the ingest event track for data channel "+webRTCChannel.getLabel(), ex);
            }
        };        
        webrtc.connect("on-data-channel", EntityIngestPipeline.OnDataChannel.class, dataChannelHandler, dataChannelHandler);
        

        // Forward ICE candidates to remote client
        webrtc.connect(new WebRTCBin.ON_ICE_CANDIDATE() {
            @Override
            public void onIceCandidate(int lineIndex, String candidate) {
                if (candidate == null){
                    LOGGER.log(Level.FINE, "Skipping null ICE candidate: {0}", lineIndex);
                    return; // Ignore null candidates instead of throwing an NPE inside the callback
                }
                if (candidate.contains("tcptype active")){
                    LOGGER.log(Level.FINE, "Skipping ICE candidate: {0} : {1}", new Object[]{lineIndex, candidate});
                    return; // Ignore active TCP out since it is likely to be caught in firewall
                }
                
                LOGGER.log(Level.FINE, "Sending ICE candidate: {0} : {1}", new Object[]{lineIndex, candidate});
                JsonObject message = new JsonObject();
                message.addProperty("cmd", "iceCandidate");
                message.addProperty("candidate", candidate);
                message.addProperty("sdpMLineIndex", lineIndex);
                socket.sendMessage(message);
            }
        });

        // Serve webrtcbin's negotiation needs: the initial offer (with the
        // base data channel guaranteed to exist before it is generated),
        // folding in needs that arrive while that offer is in flight, and
        // reporting — instead of silently dropping — any need that arrives
        // after the offer has gone out.
        webrtc.connect(new WebRTCBin.ON_NEGOTIATION_NEEDED() {
            @Override
            public void onNegotiationNeeded(Element element) {
                if (initialOfferSent) {
                    // A need that arrives after the initial offer went out can
                    // no longer be folded into it, and the protocol has no way
                    // to push a fresh unsolicited offer to the client (it only
                    // expects replies to its own commands). The old code
                    // dropped this with a FIXME, leaving dead connections;
                    // report it loudly on both ends instead.

                    // This was fixed in commit 0f8fc27892, "webrtcbin: Fix renegotiation checks", shipped in GStreamer 1.26
                    LOGGER.warning("Additional negotiation requested after the initial offer was sent - the ingest protocol cannot push a second offer, reporting instead of dropping");
                    JsonObject warning = new JsonObject();
                    warning.addProperty("cmd", "ingestError");
                    warning.addProperty("message", "The server's WebRTC stack requested a follow-up negotiation after the initial offer was already delivered, which the ingest protocol cannot deliver. The connection may be missing streams - dispose and rejoin the session to recover.");
                    socket.sendMessage(warning);
                    return;
                }
                if (initialOfferInFlight) {
                    // A need arrived while the initial offer is being
                    // generated. Remember it — the in-flight offer
                    // is discarded and regenerated to include the addition.
                    pendingInitialRenegotiation = true;
                    LOGGER.fine("Negotiation needed again while the initial offer is being generated - the offer will be regenerated to include it");
                    return;
                }
                initialOfferInFlight = true;
                LOGGER.fine("Starting the initial ingest negotiation");
                // The offer must carry the base data channel: create it
                // (idempotent) BEFORE generating any offer, on this same
                // thread — this closes the create-data-channel vs.
                // createOffer race that used to hand the client a
                // truncated, channel-less offer.
                ensureBaseChannel();
                if (baseChannel == null) { initialOfferInFlight = false; return; } // creation failed - the client was already notified by the guard; unwedge the state machine so a later need can retry, and do not generate a channel-less offer
                createInitialOffer(1);
            }
        });
        
        
        
        webrtc.connect(new WebRTCBin.PAD_ADDED() {
            @Override
            public void padAdded(Element element, Pad pad) {
                // Context for the error report back to the browser, filled in
                // as it becomes known if anything below fails
                String mediaType = null;
                String encodingType = null;
                String mid = null;
                String streamType = null;
                try {
                    LOGGER.fine("Pad added: "+pad.getName());
                    Caps caps = pad.getCurrentCaps();
                    Structure struct = caps == null ? null : caps.getStructure(0);
                    mediaType = struct == null ? null : struct.getString("media");
                    String encodingName = struct == null ? null : struct.getString("encoding-name");
                    if (mediaType == null || encodingName == null) {
                        throw new IllegalStateException("Pad "+pad.getName()+" has no codec caps yet (media "+mediaType+", encoding "+encodingName+")");
                    }
                    encodingType = encodingName.toLowerCase();
                    LOGGER.fine("Pad "+pad.getName()+": media "+mediaType+", caps "+caps+", codec "+encodingType);

                    GObject transceiver = (GObject) pad.get("transceiver");
                    mid = String.valueOf(transceiver.get("mid"));
                    StartMediaStream streamInfo = midStreamMap.get(mid);
                    if (streamInfo == null) {
                        // The browser is sending media it never announced
                        // with a startMediaStream message on the base data
                        // channel - without the announcement there is no
                        // track type to record it under
                        throw new IllegalArgumentException("No startMediaStream registration for mid "+mid+" on "+mediaType+" pad "+pad.getName()+" - the stream cannot be recorded");
                    }
                    streamType = streamInfo.streamType;
                    streamInfo.streamType+="."+mediaType;
                    LOGGER.fine("Stream is "+streamInfo.streamType);

                    String depayloaderName = "rtp"+encodingType+"depay";

                    LOGGER.fine("Creating queue");
                    Element queue = makeChecked("queue", "queue_" + pad.getName(), "ingest buffering");

                    LOGGER.fine("Creating depayloader");
                    Element depayloader = makeChecked(depayloaderName, depayloaderName + "_" + pad.getName(), "RTP depayloader for codec "+encodingType+" - usually shipped in gst-plugins-good");
                    try {
                        depayloader.set("request-keyframe",true); // Enable PLI on depayloaders that support it (vp8, h264, h265...)
                    } catch (IllegalArgumentException ex){
                        // ignore
                    }

                    LOGGER.fine("Creating parser");
                    Element parser = null;
                    if (encodingType.equals("opus")){
                        // Opus RTP caps carry no sample rate, pin one so the
                        // muxer accepts the stream (no bitstream parser needed)
                        parser = makeChecked("capsfilter", depayloaderName + "_" + pad.getName()+"-caps", "Opus sample-rate pinning");
                        parser.setCaps(Caps.fromString("audio/x-opus, rate=48000"));
                    } else if (!PARSERLESS_CODECS.contains(encodingType)) {
                        // Bitstream parser between depayloader and muxer for the
                        // codecs that need one (frame alignment / codec_data for
                        // matroskamux). The videoparsersbad elements follow the
                        // "<codec>parse" naming convention - h264parse,
                        // h265parse, vp9parse, av1parse, h263parse... 
                        String parserFactory = encodingType+"parse";
                        try {
                            parser = ElementFactory.make(parserFactory, parserFactory + "_" + pad.getName());
                        } catch (IllegalArgumentException ex) {
                            // no such parser factory on this install
                        }
                        if (parser == null) {
                            LOGGER.warning("No '"+parserFactory+"' bitstream parser for codec "+encodingType+", recording without one");
                        }
                    }

                    LOGGER.fine("Creating muxer");
                    Element muxer = makeChecked("matroskamux", "muxer_" + pad.getName(), "Matroska muxer - usually shipped in gst-plugins-good");
                    muxer.set("streamable", true);
                    muxer.set("writing-app", "SessionHistoryServer");
                    muxer.set("offset-to-zero", true); // We store the start timestamp in udta, so zero out the content
                    muxer.set("min-cluster-duration", 100000000); // 100ms clustering latency (primarily relevant for audio)

                    LOGGER.fine("Creating sink");
                    Element saver = makeChecked("appsink", "saver_" + pad.getName(), "track sink");

                    IngestMediaTrack storedTrack = new IngestMediaTrack(socket.getHistoryStorageSession(), socket.getHistoryStorageSession().createEventId(), socket.getEntityId(), socket.getConnectionId(), encodingType, streamInfo);
                    LOGGER.fine("Saving it to "+storedTrack.getSessionRelativePath());
                    storedTrack.saveConfig();
                    storedTrack.connectSink((AppSink) saver);

                    if (parser!=null){
                        pipeline.addAndLinkMany(queue, depayloader, parser, muxer, saver);
                    } else {
                        pipeline.addAndLinkMany(queue, depayloader, muxer, saver);
                    }
                    pad.link(queue.getStaticPad("sink"));
                    if (parser!=null){
                        pipeline.syncMany(queue, depayloader, parser, muxer, saver);
                    } else {
                        pipeline.syncMany(queue, depayloader, muxer, saver);
                    }

                    socket.getHistoryStorageSession().onEventAdded(storedTrack.event());
                } catch (Throwable ex){
                    LOGGER.log(Level.WARNING, "Failed to record the incoming stream on webrtc pad "+pad.getName(), ex);
                    
                    // Report the failure back to the browser 
                    JsonObject ingestError = new JsonObject();
                    ingestError.addProperty("cmd", "ingestError");
                    ingestError.addProperty("message", "Failed to record incoming "+(mediaType == null ? "media" : mediaType)+" stream on pad "+pad.getName()+": "+ex);
                    if (streamType != null) ingestError.addProperty("streamType", streamType);
                    if (mid != null) ingestError.addProperty("mid", mid);
                    if (mediaType != null) ingestError.addProperty("media", mediaType);
                    if (encodingType != null) ingestError.addProperty("codec", encodingType);
                    socket.sendMessage(ingestError);
                }
            }
        });
        
        this.negotiationOp = initialSDPOffer.op;

        pipeline.add(webrtc);
        pipeline.play();
    }

    /**
     * Create the base data channel (idempotent) and wire its handlers.
     */
    private void ensureBaseChannel() {
        if (baseChannelWired) return;
        PointerByReference channel = new PointerByReference();
        webrtc.emit("create-data-channel", "__historybasechannel", null, channel);
        // A failed create-data-channel leaves the holder at null; feeding
        // that into Natives.objectFor would itself throw (its instance
        // lookup dereferences the pointer in a ConcurrentHashMap), so the
        // null is checked BEFORE objectFor. Without the guard below, the
        // wiring that follows NPEs inside the negotiation callback, killing
        // it and leaving a dead connection the client can only wait on.
        baseChannel = channel.getValue() == null ? null : (WebRTCDataChannel) Natives.objectFor(channel.getValue(), WebRTCDataChannel.class, false, true);
        if (baseChannel == null){
            LOGGER.warning("Failed to create the base data channel - create-data-channel returned no channel, failing the negotiation instead of crashing it");
            // Answer the pending requestIngestNegotiation op fast, like
            // the other fatal path of this negotiation, instead of
            // leaving the client to sit out its reply timeout and fail
            // with a generic error.
            JsonObject reply = new JsonObject();
            reply.addProperty("cmd", "return");
            reply.addProperty("op", negotiationOp); // This is a reply
            reply.addProperty("status", false);
            reply.addProperty("message", "The server failed to create the base data channel for this ingest connection - the negotiation cannot proceed, please reconnect");
            socket.sendMessage(reply);
            // Also push an ingestError so console output and any
            // registered onIngestError hook see the failure.
            JsonObject ingestError = new JsonObject();
            ingestError.addProperty("cmd", "ingestError");
            ingestError.addProperty("message", "The server failed to create the base data channel for this ingest connection. Dispose and rejoin the session to recover.");
            socket.sendMessage(ingestError);
            // baseChannelWired stays false; the caller drops
            // initialOfferInFlight, so a later negotiation need can
            // retry the creation.
            return;
        }
        baseChannel.connect(new WebRTCDataChannel.ON_OPEN() {
            @Override
            public void onOpen(WebRTCDataChannel channel) {
                LOGGER.info("Channel open: "+channel.getLabel());
            }
        });
        baseChannel.connect((WebRTCDataChannel.ON_MESSAGE_STRING)(_c, message) -> {
            LOGGER.fine("Received a message on the base data channel");

            Gson gson = new Gson();
            JsonElement rootElement = JsonParser.parseString(message);
            JsonObject rootObject = rootElement.getAsJsonObject();
            switch (rootObject.get("cmd").getAsString()){
                case "startMediaStream":
                    onIngestMediaStreamStarted(gson.fromJson(rootElement, StartMediaStream.class));
                    break;
                case "startEventStream":
                    onIngestEventStreamStarted(gson.fromJson(rootElement, StartEventStream.class));
                    break;
                default:
                    LOGGER.fine("Ignored basechannel op: "+rootObject.get("cmd").getAsString());
            }
        });
        baseChannelWired = true; // only once the channel exists AND is wired
    }

    /**
     * Generate the initial offer (attempt number {@code attempt}) and send
     * the munged result to the client as the reply to its
     * requestIngestNegotiation. Called from the on-negotiation-needed
     * handler — never directly.
     */
    private void createInitialOffer(int attempt) {
        webrtc.createOffer(new WebRTCBin.CREATE_OFFER() {
            @Override
            public void onOfferCreated(WebRTCSessionDescription offer) {
                onInitialOfferCreated(offer, attempt);
            }
        });
    }

    /**
     * Munge, validate and deliver the initial offer (see
     * {@link #createInitialOffer}). An offer is only sent when it actually
     * carries the ingest data channel (m=application plus ICE/DTLS
     * attributes); an offer that is superseded by a negotiation need that
     * arrived while it was being generated, or that is incomplete, is
     * discarded and regenerated up to {@link #MAX_INITIAL_OFFER_ATTEMPTS}
     * times. Past that the client gets a fast, descriptive failure instead
     * of a dead offer it could only wait on forever.
     */
    private void onInitialOfferCreated(WebRTCSessionDescription offer, int attempt) {
        String sdpMessage = offer.getSDPMessage().toString();
        StringBuilder alteredSDP = new StringBuilder();
        Arrays.stream(sdpMessage.split("\n")).forEach((line) -> {
            if (!(line.startsWith("a=ssrc") || line.startsWith("a=msid-semantic"))) {
                alteredSDP.append(line).append("\n");
            }
        });

        // Force webrtc channel to be server-initiated to avoid issues with switching later
        String alteredSDPMessage = alteredSDP.toString();
        alteredSDPMessage = alteredSDPMessage.replace("a=setup:actpass", "a=setup:active");

        boolean complete = alteredSDPMessage.contains("m=application")
                && alteredSDPMessage.contains("a=ice-ufrag:")
                && alteredSDPMessage.contains("a=fingerprint:");
        boolean superseded = pendingInitialRenegotiation;
        if ((superseded || !complete) && attempt < MAX_INITIAL_OFFER_ATTEMPTS) {
            offer.disown();
            pendingInitialRenegotiation = false;
            LOGGER.fine("Discarding initial offer (attempt "+attempt+"): "+(superseded
                    ? "a follow-up negotiation need arrived while it was being generated"
                    : "it lacks the data channel (m=application) or ICE/DTLS attributes")+" - regenerating");
            createInitialOffer(attempt + 1);
            return;
        }

        SDPMessage alteredOffer = new SDPMessage();
        alteredOffer.parseBuffer(alteredSDPMessage);
        offer.disown();

        JsonObject message = new JsonObject();
        message.addProperty("cmd", "return");
        message.addProperty("op", negotiationOp); // This is a reply
        if (complete) {
            webrtc.setLocalDescription(new WebRTCSessionDescription(WebRTCSDPType.OFFER, alteredOffer));
            LOGGER.fine("SDP offer created");
            message.addProperty("status", true);
            message.addProperty("offer", alteredOffer.toString());
        } else {
            LOGGER.warning("Initial offer still incomplete after "+attempt+" attempts - failing the negotiation fast instead of sending a dead offer");
            message.addProperty("status", false);
            message.addProperty("message", "The server could not generate a complete ingest offer (missing the data channel m=application line or ICE/DTLS attributes) after "+attempt+" attempts - the negotiation cannot proceed, please reconnect");
        }
        socket.sendMessage(message);
        initialOfferSent = true;
        initialOfferInFlight = false;
    }
    
    public void onInputICECandidate(ICECandidate fromJson) {
        if (webrtc == null) {
            throw new IllegalStateException("Cannot add ice candidate to non-started WebRTC");
        }
        if (fromJson.candidate==null || fromJson.candidate.isEmpty()) return;
        webrtc.addIceCandidate(fromJson.sdpMLineIndex, fromJson.candidate);
        LOGGER.fine("Added remote ICE: " + fromJson.candidate);
    }
    
    public void onInitialNegotiationCompleted(SDPAnswer fromJson) {
        if (webrtc==null) { 
            throw new IllegalStateException("Cannot complete initial negotiation on non-started WebRTC");
        }
        LOGGER.fine("Received the client SDP answer");
        SDPMessage clientSDPAnswer = new SDPMessage();
        clientSDPAnswer.parseBuffer(fromJson.sdp);
        webrtc.setRemoteDescription(new WebRTCSessionDescription(WebRTCSDPType.ANSWER, clientSDPAnswer));
    }
    
    public void onRenegotiation(SDPOffer fromJson) {
        SDPMessage sdpOffer = new SDPMessage();
        sdpOffer.parseBuffer(fromJson.sdp);
        webrtc.setRemoteDescription(new WebRTCSessionDescription(WebRTCSDPType.OFFER, sdpOffer));        
        webrtc.createAnswer(new WebRTCBin.CREATE_ANSWER() {
            @Override
            public void onAnswerCreated(WebRTCSessionDescription wrtcsd) {                
                // TODO: We may need to force the webrtc channel to remain server initiated (active) here...
                
                webrtc.setLocalDescription(wrtcsd);
                String sdp = wrtcsd.getSDPMessage().toString();
                LOGGER.fine("SDP renegotiation answer created");
                JsonObject message = new JsonObject();                                
                message.addProperty("cmd", "return");
                message.addProperty("status", true);
                message.addProperty("op", fromJson.op); // This is a reply
                message.addProperty("answer", sdp);                
                socket.sendMessage(message);                
            }
        });
    }    
    

    private void onIngestMediaStreamStarted(StartMediaStream fromJson) {
        if (fromJson==null || fromJson.mid == null || fromJson.streamType == null) throw new IllegalArgumentException("Stream id and type must be provided");
        midStreamMap.put(fromJson.mid, fromJson);
        LOGGER.fine("Learned MID stream "+fromJson.mid+" => "+fromJson.streamType);
    }

    private void onIngestEventStreamStarted(StartEventStream fromJson) {
        if (fromJson==null || fromJson.streamType == null) throw new IllegalArgumentException("Stream type must be provided");
        eventStreamMap.put(fromJson.streamType, fromJson);
        LOGGER.fine("Learned event stream "+fromJson.streamType);
    }    
}
