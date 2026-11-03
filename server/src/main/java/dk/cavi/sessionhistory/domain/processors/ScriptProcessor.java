/**
 * Script Processor
 * Runs a user-supplied script (JavaScript via GraalVM polyglot) for every event
 * added or updated, exposing a host API through which the script can emit its
 * own output events.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.processors.Processor.ProcessorOutputSpecification;

import java.io.OutputStream;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Value;
import org.graalvm.polyglot.HostAccess;
import org.graalvm.polyglot.PolyglotException;
import org.graalvm.polyglot.ResourceLimits;

import java.util.Map;

/**
 *
 * @author jbk
 */
@JsonClassDescription("Run a script on every event creation and update")
public class ScriptProcessor extends Processor {    
    private static final Logger LOGGER = Logger.getLogger(ScriptProcessor.class.getName());
    // One executor per processor instance. (This used to be a static field:
    // every init() overwrote it, orphaning the previous pool's idle thread
    // for the JVM's lifetime, and any destroy() shut down whichever pool was
    // assigned last - breaking event processing for every script processor
    // in the session.)
    protected transient volatile ExecutorService executor;
    // volatile: the timeout watchdog (and destroy()) read this from other
    // threads; the executor's own submit/happens-before only covers tasks.
    private transient volatile Context context;
    // Shared watchdog enforcing maxExecutionTimeMs for all script
    // processors: two daemon threads, deliberately static and final -
    // never reassigned, never shut down by destroy() (unlike the executor
    // above). Each interrupt attempt occupies a watchdog thread for up to
    // ~200ms (interrupt() waits for delivery), so two threads keep one
    // stuck script from delaying every other processor's deadline; forced
    // closes additionally run on their own short-lived threads.
    protected static final ScheduledExecutorService TIMEOUT_WATCHDOG = Executors.newScheduledThreadPool(2, r -> {
        Thread t = new Thread(r, "ScriptProcessor-TimeoutWatchdog");
        t.setDaemon(true);
        return t;
    });
    // Set while a context rebuild is queued, so a burst of events failing
    // on a killed context schedules ONE rebuild instead of one per event.
    private transient volatile boolean rebuildPending;
    // Watchdog bookkeeping for the (at most one, single-threaded pool)
    // evaluation in flight. The generation counter invalidates enforcement
    // attempts whose evaluation already finished; the reported flag ties an
    // isInterrupted exception back to the watchdog rather than to a
    // destroy() racing the call.
    private transient final Object timeoutLock = new Object();
    private transient volatile int timeoutGeneration;
    private transient volatile ScheduledFuture<?> timeoutGuard;
    private transient volatile boolean timeoutReported;
    private transient Value initFn;
    private transient Value addedFn;
    private transient Value updatedFn;
    private transient Value removedFn;
    private transient Gson gson;
    private transient String logSpecifier;
    private transient String errorSpecifier;
    private transient Value jsonStringify;
    private transient Value jsonParse;

    /**
     * Loads and prepares the script engine so it is faster on later runs
     */
    public static void warmup() {
        try (Context warmupContext = Context.newBuilder("js").build()) {
            warmupContext.eval("js", "0");
        } catch (Throwable t) {
            LOGGER.log(Level.WARNING, "GraalVM warm-up failed, the first script processor will pay the engine boot cost", t);
        }
    }

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig config) {
        super.init(session, name, config);
        // The debug stream identifiers the base class keeps privately -
        // used below to skip this processor's own debug events.
        this.logSpecifier = "debug.processor."+name+".log";
        this.errorSpecifier = "debug.processor."+name+".error";
        if (executor != null) executor.shutdownNow(); // defensive: never orphan a pool if init() is ever re-entered on the same instance
        executor = Executors.newFixedThreadPool(1, r -> {
            Thread t = new Thread(r, "ScriptProcessor-"+name);
            t.setDaemon(true); // do not pin the JVM if a destroy() is ever missed
            return t;
        });
        this.gson = new Gson();

        try {
            // The init script is a script call like any other, so it is
            // bound by maxExecutionTimeMs too. It runs on the caller's
            // thread inside addProcessor's session lock - an unbounded init
            // script would hold that lock forever.
            armTimeout();
            try {
                buildScriptContext();
            } finally {
                disarmTimeout();
            }
        } catch (Throwable ex){
            exception(ex, currentProcessingTimestamp);
        }
    }

    /**
     * (Re)creates the polyglot context, evaluates the script and runs its
     * init(). Used by init() and by the recovery in ScriptTask, which
     * rebuilds the context after a statement-limit trip or a forced
     * timeout close permanently killed the previous one (a tripped limit
     * poisons the context for every later use; resetLimits() cannot revive
     * it). Script state is lost on a rebuild.
     */
    private void buildScriptContext() {
        // Set up the script context. The statementLimit is cumulative per
        // context (reset per event by resetLimits() in ScriptTask) and is
        // NOT a time box - a single statement can run unbounded, which is
        // what maxExecutionTimeMs and its watchdog below cover.
        context = Context.newBuilder("js").logHandler(new Handler() {
            @Override
            public void publish(LogRecord record) {
                log(record.getLevel() + ": " +record.getMessage(), currentProcessingTimestamp);
            }

            @Override
            public void flush() {}

            @Override
            public void close() throws SecurityException {}
        }).out(new OutputStream() {
            private StringBuilder sb = new StringBuilder();
            @Override
            public void write(int b) {
                if (b == '\n') {
                    log(sb.toString(), currentProcessingTimestamp);
                    sb.setLength(0);
                } else {
                    sb.append((char) b);
                }
            }
        })
        .allowHostAccess(HostAccess.newBuilder(HostAccess.EXPLICIT).build())
        .resourceLimits(ResourceLimits.newBuilder().statementLimit(getConfig().maxExecutionStatements, null).build())
        .allowHostClassLookup(className -> false)
        .option("log.js.level", "INFO").build();
        context.eval(getConfig().language, getConfig().script);
        switch (getConfig().language){
            case "js":
                // Handle calls Java -> js
                jsonStringify = context.eval("js", "JSON.stringify");
                jsonParse = context.eval("js", "JSON.parse");

                // Map the script functions
                initFn = context.getBindings("js").getMember("init");
                if (initFn==null) log("Warning: init() for js processor is not defined, ignoring", currentProcessingTimestamp);
                addedFn = context.getBindings("js").getMember("onEventAdded");
                if (addedFn==null) log("Warning: onEventAdded() for js processor is not defined, ignoring", currentProcessingTimestamp);
                updatedFn = context.getBindings("js").getMember("onEventUpdated");
                if (updatedFn==null) log("Warning: onEventUpdated() for js processor is not defined, ignoring", currentProcessingTimestamp);

                // Handle calls js -> Java
                context.getBindings("js").putMember("stund", new HostAPI());

                // Init the script
                if (initFn!=null) initFn.executeVoid();
                break;
            default:
                throw new IllegalStateException("Unsupported language");
        }
    }

    @Override
    public void onEventAdded(TimedEvent event) {
        // Never process our own debug output: the error/log events emitted
        // for a failing script call would feed straight back into this
        // processor, and under a broad input regex (e.g. ".*") a single
        // timeout would loop forever.
        if (event.type.equals(logSpecifier) || event.type.equals(errorSpecifier)) return;
        submitToPool(new ScriptTask(addedFn, event.clone()));
    }

    @Override
    public void onEventUpdated(TimedEvent event) {
        if (event.type.equals(logSpecifier) || event.type.equals(errorSpecifier)) return; // own debug output - see onEventAdded
        submitToPool(new ScriptTask(updatedFn, event.clone()));
    }

    /**
     * Submits a task to this processor's own pool, tolerating a destroy()
     * racing the dispatch: the pool is snapshotted (destroy() nulls the
     * field), and a shutdown pool's rejection just means the processor is
     * gone - the event is dropped rather than thrown into the session's
     * event dispatch.
     */
    private void submitToPool(ScriptTask task) {
        ExecutorService pool = executor;
        if (pool == null) return; // destroyed or never initialized - nothing to run on
        try {
            pool.submit(task);
        } catch (RejectedExecutionException destroyed) {
            // destroy() won the race - the processor is gone
        }
    }
    
    public ScriptConfig getConfig(){
        return (ScriptConfig) config;
    }

    @Override
    public void destroy() {
        // Null-safe: init() may have failed before assigning these, and
        // destroy() must never throw - removeProcessor calls it inline, and
        // an escape would abort the caller's whole cleanup.
        if (executor != null){
            executor.shutdownNow(); // also interrupts the pool thread mid-evaluation, if any
            executor = null;
        }
        disarmTimeout(); // cancel any watchdog still armed for an in-flight call
        if (context != null){
            try {
                context.close(true);
            } catch (Throwable t) {
                // close() re-throws a pending statement-limit exception of a
                // killed context - there is nothing left to recover here.
                LOGGER.log(Level.WARNING, "Failed to close the script context of "+name+" on destroy", t);
            }
            context = null;
        }
    }

    /**
     * Arms the maxExecutionTimeMs watchdog for the guest-language call that
     * is about to run on the current thread (the init script or an event
     * handler). A budget of 0 or less disables the limit.
     */
    private void armTimeout(){
        long budget = getConfig().maxExecutionTimeMs;
        synchronized (timeoutLock){
            final int gen = ++timeoutGeneration;
            if (budget <= 0) return;
            timeoutGuard = TIMEOUT_WATCHDOG.schedule(() -> enforceTimeout(gen, budget), budget, TimeUnit.MILLISECONDS);
        }
    }

    /**
     * Disarms the watchdog after the guest-language call finished (normal
     * return or throw). Bumps the generation so enforcement attempts that
     * already fired stop acting, and clears the reported flag so it cannot
     * leak into the next call.
     */
    private void disarmTimeout(){
        synchronized (timeoutLock){
            timeoutGeneration++;
            timeoutReported = false;
            ScheduledFuture<?> guard = timeoutGuard;
            timeoutGuard = null;
            if (guard != null) guard.cancel(false);
        }
    }

    /**
     * Watchdog thread: the budget elapsed for generation {@code gen}.
     * Soft phase first - interrupt the context, which is non-destructive
     * (the context stays usable for later calls). The interrupt is issued
     * under the timeout lock so a racing disarm (evaluation finished)
     * either observes it or makes this attempt give up - the interrupt can
     * never land on the NEXT evaluation.
     */
    private void enforceTimeout(int gen, long budget){
        Context ctx;
        boolean delivered = false;
        boolean retry = false;
        synchronized (timeoutLock){
            if (gen != timeoutGeneration) return; // the evaluation already finished
            if (context == null){
                // The guard fired while a context build is still in flight
                // (the field is assigned before any guest eval runs, so this
                // window is milliseconds) - check again shortly.
                TIMEOUT_WATCHDOG.schedule(() -> enforceTimeout(gen, budget), 300, TimeUnit.MILLISECONDS);
                return;
            }
            ctx = context;
            // Set before interrupting: the failing evaluation's catch may
            // run before interrupt() returns, and a pending interrupt may
            // still take effect the moment an uninterruptible op ends.
            timeoutReported = true;
            try {
                ctx.interrupt(Duration.ofMillis(200)); // waits at most 200ms for delivery
                delivered = true;
            } catch (TimeoutException notDelivered) {
                retry = true; // the current op is uninterruptible in flight
            } catch (Throwable t) {
                LOGGER.log(Level.WARNING, "Enforcing maxExecutionTimeMs on "+name+" failed", t);
                return;
            }
        }
        if (delivered){
            logSafe("Warning: a script call on "+name+" exceeded maxExecutionTimeMs="+budget+"ms and was interrupted (the script context stays usable)");
        } else if (retry){
            // A single timed-out interrupt is silently discarded once the
            // uninterruptible op completes - retried interrupts deliver
            // exactly then. Escalate to a forced close if the whole grace
            // period passes without delivery.
            long graceEnd = System.currentTimeMillis() + Math.max(1000, budget);
            scheduleInterruptRetry(gen, ctx, budget, graceEnd);
        }
    }

    private void scheduleInterruptRetry(int gen, Context ctx, long budget, long graceEnd){
        long delay = 300;
        if (System.currentTimeMillis() + delay >= graceEnd){
            escalateClose(gen, ctx, budget);
            return;
        }
        TIMEOUT_WATCHDOG.schedule(() -> {
            boolean delivered = false;
            synchronized (timeoutLock){
                if (gen != timeoutGeneration || context != ctx) return; // finished, or the context was rebuilt meanwhile
                timeoutReported = true;
                try {
                    ctx.interrupt(Duration.ofMillis(200));
                    delivered = true;
                } catch (TimeoutException notDelivered) {
                    // retry again below
                } catch (Throwable t) {
                    LOGGER.log(Level.WARNING, "Enforcing maxExecutionTimeMs on "+name+" failed", t);
                    return;
                }
            }
            if (delivered){
                logSafe("Warning: a script call on "+name+" exceeded maxExecutionTimeMs="+budget+"ms and was interrupted after a retry (the script context stays usable)");
            } else {
                scheduleInterruptRetry(gen, ctx, budget, graceEnd);
            }
        }, delay, TimeUnit.MILLISECONDS);
    }

    /**
     * Last resort after the grace period: forcibly close the context - the
     * only mechanism that stops an atomic uninterruptible op mid-run
     * (measured on the shipped polyglot: close(true) killed a 10s
     * String.split ~90ms in, where interrupts were ignored). Destructive:
     * the context dies and the evaluating thread rebuilds it (see
     * maybeRebuildAfterCancel). It blocks its caller for up to a few
     * seconds, so it runs on its own thread to keep the shared watchdog
     * responsive for other processors.
     */
    private void escalateClose(int gen, Context ctx, long budget){
        // Kill FIRST, log afterwards: the log goes through the session's
        // event fan-out, whose receivers can throw, and that must never
        // prevent the close from starting.
        Thread killer = new Thread(() -> {
            // The close runs under the timeout lock: while it is being
            // delivered (up to a few seconds) no disarm can slip in, so the
            // cancel can only hit the over-budget evaluation - never a
            // later, healthy one that picked up the pool thread meanwhile.
            synchronized (timeoutLock){
                if (gen != timeoutGeneration || context != ctx) return; // finished, or already rebuilt
                try {
                    ctx.close(true);
                } catch (Throwable t) {
                    LOGGER.log(Level.WARNING, "Forcibly closing the script context of "+name+" failed", t);
                }
                submitRebuild();
            }
        }, "ScriptProcessor-CloseEscalation-"+name);
        killer.setDaemon(true);
        killer.start();
        logSafe("Warning: a script call on "+name+" ignored interrupts for the whole grace period after exceeding maxExecutionTimeMs="+budget+"ms - forcibly closing the script context (it will be rebuilt)");
    }

    /**
     * A tripped statement limit or a forced close permanently kills the
     * context - every later use keeps throwing, and resetLimits() cannot
     * revive it (verified on the shipped polyglot). Rebuild it on this
     * processor's own thread so later events work again instead of failing
     * forever. The script's init() reruns; script state is lost.
     */
    private void maybeRebuildAfterCancel(Throwable ex){
        if (!(ex instanceof PolyglotException pe) || !pe.isCancelled()) return;
        submitRebuild();
    }

    /**
     * Queues ONE context rebuild (guarded by rebuildPending, so a burst of
     * events failing on a killed context does not queue one rebuild per
     * event). The rebuild runs on this processor's own thread: it closes
     * the dead context, builds a fresh one and reruns the script's init()
     * (script state is lost). A destroy() racing the rebuild is tolerated:
     * the task gives up if the processor is gone by the time it runs, and
     * closes the fresh context instead of leaking it if destroy() lands
     * mid-build.
     */
    private void submitRebuild(){
        ExecutorService pool = executor;
        if (pool == null) return; // destroyed meanwhile
        synchronized (timeoutLock){
            if (rebuildPending) return;
            rebuildPending = true;
        }
        try {
            pool.submit(() -> {
                try {
                    if (executor == null) return; // destroyed before we started
                    logSafe("Rebuilding the script context of "+name+" after it was closed (statement limit tripped, or forced close after a timeout)");
                    Context old = context;
                    try {
                        if (old != null) old.close(true);
                    } catch (Throwable alreadyKilled) {
                        // a killed context re-throws its pending exception on close - nothing to recover
                    }
                    armTimeout();
                    try {
                        buildScriptContext();
                    } finally {
                        disarmTimeout();
                    }
                } catch (Throwable t) {
                    try {
                        exception(t, currentProcessingTimestamp);
                    } catch (Throwable t2) {
                        LOGGER.log(Level.WARNING, "Reporting a script context rebuild failure on "+name+" failed as well", t2);
                    }
                } finally {
                    synchronized (timeoutLock){
                        rebuildPending = false;
                    }
                    if (executor == null && context != null){
                        // destroy() landed mid-rebuild: do not leak the
                        // fresh context on a removed processor
                        try {
                            context.close(true);
                        } catch (Throwable t) {
                            LOGGER.log(Level.WARNING, "Closing the script context of the removed processor "+name+" failed", t);
                        }
                        context = null;
                    }
                }
            });
        } catch (RejectedExecutionException destroyed) {
            synchronized (timeoutLock){
                rebuildPending = false;
            }
            // destroy() raced the rebuild - the processor is gone
        }
    }

    /**
     * log() for use from the watchdog, escalation and rebuild threads:
     * reporting goes through the session's event fan-out, whose receivers
     * can throw - the timeout machinery itself must never die to a logging
     * failure.
     */
    private void logSafe(String message){
        try {
            log(message, currentProcessingTimestamp);
        } catch (Throwable t) {
            LOGGER.log(Level.WARNING, "Logging from the script timeout machinery of "+name+" failed", t);
        }
    }

    private class ScriptTask implements Runnable {
        private Value fn;
        private TimedEvent event;

        public ScriptTask(Value fn, TimedEvent event) {
            this.fn = fn;
            this.event = event;
        }
        
        @Override
        public void run() {
            Context ctx = context;
            if (ctx == null) return; // destroyed between submit and run
            // A stale Java interrupt flag (e.g. left by a destroy() that
            // interrupted this thread) would fail the next guest call
            // immediately - clear it.
            Thread.interrupted();
            // A watchdog timeout surfaces as PolyglotException with
            // isInterrupted(); the reported flag set by the watchdog tells
            // it apart from a destroy() interrupting the thread. It must
            // be read (inner catch below) before the finally clears it.
            boolean timedOut = false;
            try {
                ctx.resetLimits();
                String json = null;
                synchronized (gson){
                    json = gson.toJson(event);
                }
                armTimeout();
                try {
                    Value jsObj = jsonParse.execute(json);
                    fn.executeVoid(jsObj);
                } catch (Throwable ex){
                    if (ex instanceof PolyglotException pe && pe.isInterrupted()){
                        synchronized (timeoutLock){
                            timedOut = timeoutReported;
                        }
                    }
                    throw ex;
                } finally {
                    disarmTimeout();
                }
            } catch (Throwable ex){
                // Recover FIRST: reporting goes through the session's event
                // fan-out, whose receivers can throw, and that must never
                // prevent the rebuild of a killed context.
                maybeRebuildAfterCancel(ex);
                long ts = (event.end!=null)?event.end:event.start;
                try {
                    if (timedOut){
                        exception(new TimeoutException("Script call exceeded maxExecutionTimeMs="+getConfig().maxExecutionTimeMs+"ms and was interrupted"), ts);
                    } else {
                        exception(ex, ts);
                    }
                } catch (Throwable t) {
                    LOGGER.log(Level.WARNING, "Reporting a script failure on "+name+" failed as well", t);
                }
            }
        }
    }
    
    public static class ScriptConfig extends ProcessorConfig {
        @JsonProperty(required = true)
        @JsonPropertyDescription("The language of the code, only 'js' is supported for now")
        public String language = "js";
        
        @JsonProperty(required = true)
        @JsonPropertyDescription("The code to run, must contain init(), onEventAdded(ev) and onEventUpdated(ev)")
        public String script = """
/**
 * Called once when plugin is loaded.
 */
function init() {
        console.log("Hello World");
}
            
/**
 * Entry point for new events
 */
function onEventAdded(ev) {
}

/**
 * Entry point for updates to existing tentative events
 */
function onEventUpdated(ev) {
}
        """;
        
        @JsonPropertyDescription("Maximal time per call (in milliseconds), enforced by a watchdog; 0 or less disables the limit")
        public long maxExecutionTimeMs = 1000;
        @JsonPropertyDescription("Maximum number of statements to execute per call")
        public long maxExecutionStatements = 20000;
    }

    public class HostAPI {
        @HostAccess.Export
        public EventStream startEventStream(String streamSpecifier){
            return new EventStream(streamSpecifier);
        }
    }
    
    public class EventStream {
        private final ProcessorOutputSpecification output;
        private String streamSpecifier;

        public EventStream(String streamSpecifier) {
            // Check that this matches the output specs
            if (!config.outputs.containsKey(streamSpecifier)) throw new IllegalArgumentException("Event stream ID provided ("+streamSpecifier+") does not match any output configured for this processor: "+String.join(", ", config.outputs.keySet()));
            this.output = config.outputs.get(streamSpecifier);
            this.streamSpecifier = streamSpecifier;
        }        
        
        /**
         * Checks value against schema and converts it to a JsonObject
         * @param jsObject
         * @return 
         */
        private JsonObject importValueToObject(Value jsObject){
            Value jsonVal = jsonStringify.execute(jsObject);
            String json = jsonVal.asString();
            output.validate(json);
            return gson.fromJson(json, JsonObject.class);
        }        
        
        @HostAccess.Export
        public void createInstantEvent(Value jsObject, long timestamp){
            createInstantEvent(jsObject, timestamp, null);
        }
        
        @HostAccess.Export
        public void createInstantEvent(Value jsObject, long timestamp, String entity){
            JsonObject data = importValueToObject(jsObject);

            TimedEvent instantEvent = new TimedEvent(streamSpecifier, session.createEventId());
            instantEvent.start = timestamp;
            instantEvent.entity = entity;
            instantEvent.data = data;            
            session.onEventAdded(instantEvent);
        }
    
        public class DurationEvent {
            private final TimedEvent currentEvent;
            
            public DurationEvent(Value jsObject, long startTimestamp, String entity) {
                JsonObject data = importValueToObject(jsObject);

                currentEvent = new TimedEvent(streamSpecifier, session.createEventId());
                currentEvent.start = startTimestamp;
                currentEvent.end = startTimestamp;
                currentEvent.entity = entity;
                currentEvent.data = data;        
                currentEvent.tentative = true;
                session.onEventAdded(currentEvent);             
            }

            @HostAccess.Export
            public void update(Value jsObject, Long endTimestamp){
                if (currentEvent.tentative==false) throw new IllegalStateException("This event has been marked as completed at "+currentEvent.end+" and can no longer be updated");
                JsonObject data = importValueToObject(jsObject);
                
                // Plain event fields
                if (endTimestamp!=null) {
                    if (endTimestamp<currentEvent.start) throw new IllegalArgumentException("End timestamp of "+endTimestamp+" cannot be before start of "+currentEvent.start);
                    currentEvent.end = endTimestamp;
                }
                
                // Merge top-level of data field
                if (currentEvent.data==null){
                    currentEvent.data = data;
                } else {
                    for (Map.Entry<String, JsonElement> entry : data.entrySet()) {
                        ((JsonObject)currentEvent.data).add(entry.getKey(), entry.getValue());
                    }                
                }                
                
                session.onEventUpdated(currentEvent);
            }
            
            @HostAccess.Export
            public void stop(){
                currentEvent.tentative = false;
                session.onEventUpdated(currentEvent);
           }
        }        
        
        @HostAccess.Export
        public DurationEvent createDurationEvent(Value jsObject, long timestamp) {
            return new DurationEvent(jsObject, timestamp, null);
        }
        
        @HostAccess.Export
        public DurationEvent createDurationEvent(Value jsObject, long timestamp, String entity) {
            return new DurationEvent(jsObject, timestamp, entity);
        }
    }    
}
