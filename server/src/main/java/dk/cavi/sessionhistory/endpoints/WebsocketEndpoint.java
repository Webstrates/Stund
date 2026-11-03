/**
 * Websocket Endpoint
 * Primary client-facing API of the server: a websocket that dispatches commands
 * for WebRTC ingest negotiation, model subscriptions, processor management and
 * session lifecycle, and pushes model updates and schema changes back to the
 * client.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.endpoints;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.github.victools.jsonschema.generator.Option;
import com.github.victools.jsonschema.generator.SchemaGenerator;
import com.github.victools.jsonschema.generator.SchemaGeneratorConfig;
import com.github.victools.jsonschema.generator.SchemaGeneratorConfigBuilder;
import com.github.victools.jsonschema.generator.SchemaVersion;
import com.github.victools.jsonschema.module.jackson.JacksonSchemaModule;
import com.google.gson.*;

import dk.cavi.sessionhistory.api_websocket.EventQuery;
import dk.cavi.sessionhistory.api_websocket.HistoryModelReference;
import dk.cavi.sessionhistory.api_websocket.ICECandidate;
import dk.cavi.sessionhistory.api_websocket.ProcessorReference;
import dk.cavi.sessionhistory.api_websocket.SDPAnswer;
import dk.cavi.sessionhistory.api_websocket.SDPOffer;
import dk.cavi.sessionhistory.auth.WebsocketAuthConfigurator;
import dk.cavi.sessionhistory.core.ClassFinder;
import dk.cavi.sessionhistory.domain.EntityIngestPipeline;
import dk.cavi.sessionhistory.domain.SchemaChangeListener;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.EventModel;
import dk.cavi.sessionhistory.domain.model.FilteredEventUpdateListener;
import dk.cavi.sessionhistory.domain.model.ModelUpdateTracker;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.processors.Processor;
import dk.cavi.sessionhistory.domain.processors.ProcessorDeserializer;

import java.io.IOException;
import java.lang.reflect.Type;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import jakarta.websocket.CloseReason;
import jakarta.websocket.CloseReason.CloseCodes;
import jakarta.websocket.OnClose;
import jakarta.websocket.OnError;
import jakarta.websocket.OnMessage;
import jakarta.websocket.OnOpen;
import jakarta.websocket.RemoteEndpoint.Async;
import jakarta.websocket.Session;
import jakarta.websocket.server.PathParam;
import jakarta.websocket.server.ServerEndpoint;
import java.lang.reflect.Modifier;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.eclipse.jetty.io.EofException;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Primary client-facing websocket API of the server.
 * 
 * @author jbk
 */
@ServerEndpoint(value = "/session/{sessionId}/{entityId}", configurator = WebsocketAuthConfigurator.class)
public class WebsocketEndpoint implements Runnable, FilteredEventUpdateListener, SchemaChangeListener {
    private static final Logger LOGGER = Logger.getLogger(WebsocketEndpoint.class.getName());
    private static final Gson gson = new Gson();

    private Session wsSession;
    private ConcurrentLinkedQueue<String> websocketMessageQueue;
    private Thread pingThread;
    private SessionStorage historyStorageSession;
    
    private EntityIngestPipeline pipeline;
    private String entityId;
    // Subscription ids are handed out monotonically and never reused, so they stay stable across disconnects.
    // The map must stay concurrent: onFilteredEventBulkUpdate iterates it without the lock, from tracker threads.
    private Map<Integer, ModelUpdateTracker> modelSubscriptions = new ConcurrentHashMap<>();
    private int nextSubscriptionId = 0;

    @OnOpen
    public void onOpen(Session websocketSession, @PathParam("sessionId") final String sessionId, @PathParam("entityId") final String entityId) {
        this.wsSession = websocketSession;
        this.entityId = entityId;
        LOGGER.info("Opening Jetty SessionHistory session: " + sessionId + ", connection: "+websocketSession.getId()+" for "+entityId);  
        
        try {
            this.historyStorageSession = SessionStorage.get(sessionId);
            if (getHistoryStorageSession()==null) throw new IllegalArgumentException("Could not load session "+sessionId);
        } catch (Throwable ex){
            CloseReason reason = new CloseReason(CloseCodes.UNEXPECTED_CONDITION, 
                ex.getMessage());
            LOGGER.log(Level.SEVERE, "Failed to open session history session " + sessionId, ex);
            try {
                wsSession.close(reason);
            } catch (IOException ex2){
                LOGGER.log(Level.WARNING, "Failed to deliver the rejection to the client", ex2);
            }
            return;
        }
        
        websocketMessageQueue = new ConcurrentLinkedQueue<>();
        websocketSession.setMaxIdleTimeout(0);
        
        pingThread = new Thread(this);
        pingThread.setDaemon(true);
        pingThread.setName("WebsockPing-"+websocketSession.getId());
        pingThread.start();
        
        historyStorageSession.addSchemaChangeListener(this);
    }
    
    public String getConnectionId(){
        return wsSession.getId();
    }
    
    @Override
    public void onSchemaChanged(){
        JsonObject message = new JsonObject();
        message.addProperty("cmd", "schemaChange");
        message.add("schema", gson.toJsonTree(historyStorageSession.getSchema()));
        sendMessage(message);
    }

    @OnClose
    public void onClose() throws InterruptedException {
        pingThread.interrupt();
        
        historyStorageSession.removeSchemaChangeListener(this);

        synchronized (modelSubscriptions) {
            modelSubscriptions.values().forEach((subscription) -> {
                subscription.destroy();
            });
        }
        
        if (pipeline!=null) pipeline.destroy();
        
        LOGGER.info("Closed SessionHistory session: "+wsSession.getId());
        this.wsSession = null;
    }
    
    @OnError
    public void error(Session wsSession, Throwable t) {
        LOGGER.log(Level.SEVERE, "Websocket error for session "+wsSession.getId(), t);
    }

    @OnMessage
    public void message(String msg) {
        JsonObject jsonMessage = gson.fromJson(msg, JsonObject.class);

        try {
            final String cmd = jsonMessage.get("cmd").getAsString();
            switch (cmd) {
                case "requestIngestNegotiation":
                    this.createIngestPipeline(gson.fromJson(jsonMessage, SDPOffer.class));                           
                    break;
                case "completeIngestNegotiation":
                    pipeline.onInitialNegotiationCompleted(gson.fromJson(jsonMessage, SDPAnswer.class));
                    break;                    
                case "requestIngestRenegotiation":
                    pipeline.onRenegotiation(gson.fromJson(jsonMessage, SDPOffer.class));
                    break;
                case "ingestICECandidate":
                    pipeline.onInputICECandidate(gson.fromJson(jsonMessage, ICECandidate.class));
                    break;
                case "connectModel":
                    HistoryModelReference connectModelCommand = gson.fromJson(jsonMessage, HistoryModelReference.class);
                    EventModel model = historyStorageSession.getModel(connectModelCommand.model);
                    if (model==null) throw new IllegalArgumentException("No such model to subscribe to: "+connectModelCommand.model);
                    synchronized (modelSubscriptions) {
                        ModelUpdateTracker tracker = new ModelUpdateTracker(model, this);
                        int subscriptionId = nextSubscriptionId++;
                        modelSubscriptions.put(subscriptionId, tracker);
                        JsonObject message = new JsonObject();
                        message.addProperty("cmd", "return");
                        message.addProperty("status", true);
                        message.addProperty("subscription", subscriptionId);
                        message.addProperty("op", connectModelCommand.op); // This is a reply          
                        sendMessage(message);
                        tracker.init();
                    }
                    break;
                case "disconnectModel":
                    HistoryModelReference disconnectModelCommand = gson.fromJson(jsonMessage, HistoryModelReference.class);
                    synchronized (modelSubscriptions) {
                        List<Integer> subscriptionIds = new ArrayList<>();
                        for (Map.Entry<Integer, ModelUpdateTracker> entry : modelSubscriptions.entrySet()) {
                            if (disconnectModelCommand.model.equals(entry.getValue().getModel().getName())) subscriptionIds.add(entry.getKey());
                        }
                        if (subscriptionIds.isEmpty()) throw new IllegalArgumentException("Cannot remove subscription for "+disconnectModelCommand.model+" because it could not be found in current subscriptions");
                        for (Integer subscriptionId : subscriptionIds) {
                            ModelUpdateTracker removed = modelSubscriptions.remove(subscriptionId);
                            if (removed!=null) removed.destroy();
                        }
                        JsonObject message = new JsonObject();
                        message.addProperty("cmd", "return");
                        message.addProperty("status", true);
                        message.addProperty("op", disconnectModelCommand.op); // This is a reply                                 
                        sendMessage(message);
                    }
                    break;
                case "getEvent":
                    EventQuery eventQuery = gson.fromJson(jsonMessage, EventQuery.class);
                    TimedEvent event = historyStorageSession.lookupEvent(eventQuery.id);
                    if (event==null) throw new IllegalArgumentException("No such event "+eventQuery.id);

                    // FIXME: setup gson to ignore meta based on options

                    JsonObject eventsReply = new JsonObject();
                    eventsReply.addProperty("cmd", "return");
                    eventsReply.addProperty("status", true);
                    eventsReply.addProperty("op", eventQuery.op); // This is a reply                                 
                    eventsReply.add("event", gson.toJsonTree(event));
                    sendMessage(eventsReply);
                    break;                                        
                case "addProcessor":
                    Processor uninitializedProcessor = ProcessorDeserializer.getReader().fromJson(jsonMessage, Processor.class);
                    historyStorageSession.addProcessor(uninitializedProcessor.getName(), uninitializedProcessor, uninitializedProcessor.getConfig());
                    historyStorageSession.saveConfig();
                    JsonObject addReply = new JsonObject();
                    addReply.addProperty("cmd", "return");
                    addReply.addProperty("status", true);
                    addReply.addProperty("op", jsonMessage.get("op").getAsInt()); // This is a reply                                 
                    sendMessage(addReply);
                    break;
                case "removeProcessor":
                    ProcessorReference removeProcessorCommand = gson.fromJson(jsonMessage, ProcessorReference.class);
                    if (!historyStorageSession.removeProcessor(removeProcessorCommand.processor)) throw new IllegalArgumentException("No such processor "+removeProcessorCommand.processor);
                    historyStorageSession.saveConfig();
                    JsonObject removeReply = new JsonObject();
                    removeReply.addProperty("cmd", "return");
                    removeReply.addProperty("status", true);
                    removeReply.addProperty("op", removeProcessorCommand.op); // This is a reply                                 
                    sendMessage(removeReply);
                    break;
                case "getSupportedProcessors":
                    List<Class<?>> processorClasses = ClassFinder.singleton().findSubclasses(Processor.class);
                    Map<String,JsonObject> processorMap = new HashMap<>();
                    ObjectMapper objectMapper = new ObjectMapper();
                    SchemaGeneratorConfigBuilder configBuilder = new SchemaGeneratorConfigBuilder(SchemaVersion.DRAFT_7);
                    SchemaGeneratorConfig schemaGeneratorConfig = configBuilder
                        .without(
                                Option.NONPUBLIC_STATIC_FIELDS,
                                Option.TRANSIENT_FIELDS,
                                Option.GETTER_METHODS,
                                Option.FIELDS_DERIVED_FROM_ARGUMENTFREE_METHODS,
                                Option.VOID_METHODS,
                                Option.NULLABLE_FIELDS_BY_DEFAULT)
                            .with(new JacksonSchemaModule())
                        .build();
                    SchemaGenerator schemaGenerator = new SchemaGenerator(schemaGeneratorConfig);

                    processorClasses.forEach(processorClass -> {
                        try {
                            if (Modifier.isAbstract(processorClass.getModifiers())) return;
                            Type configType = ProcessorDeserializer.getConfigType(processorClass);
                            ObjectNode schemaNode = schemaGenerator.generateSchema(configType);
                            JsonObject processorNode = new JsonObject();
                            
                            JsonClassDescription classDescription = processorClass.getAnnotation(JsonClassDescription.class);
                            if (classDescription!=null) processorNode.addProperty("description", classDescription.value());
                            processorNode.add("configSchema", JsonParser.parseString(objectMapper.writeValueAsString(schemaNode)));
                            
                            processorMap.put(processorClass.getSimpleName(), processorNode);
                        } catch (JsonSyntaxException e) {
                            LOGGER.log(Level.WARNING, "Failed to generate the processor schema for " + processorClass.getName(), e);
                        } catch (NoSuchMethodException e) {
                            LOGGER.warning("Ignoring processor class " + processorClass.getSimpleName() + " without a getConfig() method");
                        }
                    });

                    
                    JsonObject schemaResponse = new JsonObject();
                    schemaResponse.addProperty("cmd", "return");
                    schemaResponse.addProperty("status", true);
                    schemaResponse.addProperty("op", jsonMessage.get("op").getAsInt());
                    schemaResponse.add("processors", gson.toJsonTree(processorMap));
                    sendMessage(schemaResponse);
                    break;
                case "ping":
                    JsonObject message = new JsonObject();
                    final int op = jsonMessage.get("op").getAsInt();
                    message.addProperty("cmd", "return"); // This is a reply
                    message.addProperty("status", true);
                    message.addProperty("op", op);
                    sendMessage(message);
                    break;
                case "start":
                    if (!entityId.equals(historyStorageSession.getSchema().owner)) throw new IllegalArgumentException("Must be owner of session to start it");
                    if (historyStorageSession.getSchema().end!=null) throw new IllegalArgumentException("Cannot start a session that has already ended");
                    if (historyStorageSession.getSchema().start!=null) throw new IllegalArgumentException("Cannot start a session that has already started");
                    historyStorageSession.onStarted();
                    JsonObject startReply = new JsonObject();
                    startReply.addProperty("cmd", "return");
                    startReply.addProperty("status", true);
                    startReply.addProperty("op", jsonMessage.get("op").getAsInt()); // This is a reply
                    sendMessage(startReply);
                    break;
                case "stop":
                    if (!entityId.equals(historyStorageSession.getSchema().owner)) throw new IllegalArgumentException("Must be owner of session to end it");
                    if (historyStorageSession.getSchema().end!=null) throw new IllegalArgumentException("Cannot end a session that has already ended");
                    if (historyStorageSession.getSchema().start==null) throw new IllegalArgumentException("Cannot end a session that hasn't started");
                    historyStorageSession.onEnded();
                    JsonObject stopReply = new JsonObject();
                    stopReply.addProperty("cmd", "return");
                    stopReply.addProperty("status", true);
                    stopReply.addProperty("op", jsonMessage.get("op").getAsInt()); // This is a reply
                    sendMessage(stopReply);
                    break;
                default:
                    LOGGER.warning("Ignoring message with unknown command '" + cmd + "'");
            }
        } catch (Throwable ex) {
            LOGGER.log(Level.WARNING, "Failed to handle websocket message for session " + wsSession.getId(), ex);
            JsonObject message = new JsonObject();
            final int op = jsonMessage.get("op").getAsInt();
            message.addProperty("status", false);
            message.addProperty("op", op);
            message.addProperty("cmd", "return");
            message.addProperty("message", ex.toString());
            sendMessage(message);
            
        }
    }

    @Override
    public void run() {
        // Send messages over the websocket in regular intervals to detect hanging clients
        long lastStatusTick = System.currentTimeMillis();

        while (wsSession!=null && wsSession.isOpen() && !pingThread.isInterrupted()){
            try {
                if (System.currentTimeMillis() - lastStatusTick > 5000){
                    JsonObject message = new JsonObject();
                    message.addProperty("cmd", "status");
                    websocketMessageQueue.add(message.toString());
                    lastStatusTick = System.currentTimeMillis();
                }

                String message = websocketMessageQueue.poll();
                boolean didSomething = false;
                if (message!=null){
                    didSomething = true;
                    if (!wsSession.isOpen()) {
                        LOGGER.fine("Skipping send: the websocket session is no longer open");
                    } else {
                        Async sender = wsSession.getAsyncRemote();
                        Future<Void> f = sender.sendText(message);
                        try {
                            f.get();
                        } catch (ExecutionException ex){
                            throw ex.getCause();
                        }
                    }
                }
                
                if (!didSomething){
                    Thread.sleep(1);
                }                
            } catch (InterruptedException ex){
                LOGGER.fine("Handled interrupt: webpinger");
            } catch (EofException ex){
                LOGGER.info("The websocket sender thread reached EOF for session "+wsSession.getId());
            } catch (Throwable ex){
                LOGGER.log(Level.SEVERE, "The websocket sender thread failed", ex);
            }
        }

        LOGGER.fine("Closed a pinger thread for a session");
    }
    
    public void sendMessage(JsonObject message){
        websocketMessageQueue.add(message.toString());        
    }

    /**
     * Called on the server when a client provides SDP
     * @param offer
     */
    private void createIngestPipeline(SDPOffer offer) {
        // Forward answer to streamer to finilizae new WebRTC session
        LOGGER.fine("Creating the ingest pipeline from an SDP offer");
        if (pipeline!=null) throw new IllegalStateException("Ingest pipeline already exists");
        
        pipeline = new EntityIngestPipeline(this, offer);
    }

    /**
     * @return the historyStorageSession
     */
    public SessionStorage getHistoryStorageSession() {
        return historyStorageSession;
    }

    /**
     * @return the entityId
     */
    public String getEntityId() {
        return entityId;
    }

    @Override
    public void onFilteredEventBulkUpdate(ModelUpdateTracker source, JsonObject update) {
        Integer subscriptionId = null;
        for (Map.Entry<Integer, ModelUpdateTracker> entry : modelSubscriptions.entrySet()) {
            if (entry.getValue()==source) {
                subscriptionId = entry.getKey();
                break;
            }
        }
        if (subscriptionId==null) {
            LOGGER.warning("Ignoring a filtered event update from an unsubscribed model");
            return;
        }
        
        JsonObject output = update.deepCopy();
        output.addProperty("cmd", "modelChange");
        output.addProperty("subscription", subscriptionId);
        sendMessage(output);        
    }


}
