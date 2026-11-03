/**
 * ClassFinder
 * Scans the classpath once for the available classes
 *
 * Copyright (c) 2009-2020 Rolf Bagge, Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.core;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;
import java.util.StringTokenizer;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.logging.Level;
import java.util.logging.Logger;

import dk.cavi.sessionhistory.domain.processors.Processor;

/**
 * This utility can find subclasses and classes from the classpath.
 *
 * Idea based loosely on several other "ClassFinder"-like ideas
 *
 * @author Rolf
 */
public class ClassFinder {
    private static final Logger LOGGER = Logger.getLogger(ClassFinder.class.getName());
    private static ClassFinder singleton;
    private final List<Class<?>> searchTargets;
    private final Set<Class<?>> availableClasses;

    private ClassFinder() {
        searchTargets = new ArrayList<>();
        availableClasses = new LinkedHashSet<>();

        LOGGER.fine("Classfinder is scanning...");
        searchTargets.add(Processor.class);
        setupClassPathMap();
        LOGGER.fine("Classfinder scan complete");
    }

    /**
     * Returns the singleton instance; the first call runs the
     * classpath scan.
     */
    public synchronized static ClassFinder singleton() {
        if(singleton == null) {
            singleton = new ClassFinder();
        }

        return singleton;
    }

    /**
     * Walks the current classpath (plus a ./lib directory, if present)
     * and offers every candidate class to scanAndLoad: directories
     * are scanned recursively via includeDir, jar files via includeJar.
     */
    private void setupClassPathMap() {
        String classPath = System.getProperty("java.class.path");
        String pathSeparator = System.getProperty("path.separator");

        //Add lib path for searching for jar files.
        classPath += pathSeparator + "./lib";

        StringTokenizer tokenizer = new StringTokenizer(classPath, pathSeparator);

        while(tokenizer.hasMoreTokens()) {
            String path = tokenizer.nextToken();

            //Check if its a directory
            File f = new File(path);
            if(f.isDirectory()) {
                includeDir(f, "");
            } else if(f.getName().endsWith(".jar")) {
                try {
                    JarFile jar = new JarFile(f);
                    includeJar(jar);
                } catch (IOException ex) {
                    LOGGER.log(Level.SEVERE, "Could not open the jar file " + f + " from the classpath", ex);
                }
            }
        }
    }

    /**
     * Loads a class found by the scan - without initializing it - if
     * its name is under dk.cavi.sessionhistory.domain.processors and
     * it is assignable to one of the search targets; every other
     * class is ignored. Classes that fail to load are logged and
     * skipped.
     */
    private void scanAndLoad(String className){
        if(className.startsWith("dk.cavi.sessionhistory.domain.processors")) {
            try {
                Class<?> c = Class.forName(className, false, ClassFinder.class.getClassLoader());
                if (searchTargets.stream().anyMatch(target -> target.isAssignableFrom(c))){
                    availableClasses.add(c);
                }
            } catch (Throwable ex) {
                if (ex.getCause()!=null){
                    LOGGER.log(Level.WARNING, "Skipping {0}: {1}", new Object[]{className, ex.getCause()});
                } else {
                    LOGGER.log(Level.WARNING, "Skipping {0}: {1}", new Object[]{className, ex});
                }

            }
        }
    }

    /**
     * Scans a directory tree for classes: subdirectories are walked
     * with the package prefix accumulated so far, jar files found on
     * the way are scanned via includeJar, and .class files are
     * offered to scanAndLoad.
     */
    private void includeDir(File classDir, String prefix) {
        for(File f : classDir.listFiles()) {
            if(f.isDirectory()) {
                includeDir(f, prefix+f.getName()+".");
            } else if(f.getName().endsWith(".jar")) {
                try {
                    includeJar(new JarFile(f));
                } catch (IOException ex) {
                    LOGGER.log(Level.SEVERE, "Could not open the jar file " + f + " while scanning for classes", ex);
                }
            } else if(f.getName().endsWith(".class")) {
                String foundClass = prefix+f.getName().substring(0, f.getName().lastIndexOf('.'));
                scanAndLoad(foundClass);
            }
        }
    }

    /**
     * Scans every .class entry of the jar and offers the class names
     * to scanAndLoad.
     */
    private void includeJar(JarFile jar) {
        for(JarEntry entry : Collections.list(jar.entries())) {
            if(entry.getName().endsWith(".class")) {
                String foundPath = entry.getName().substring(0, entry.getName().lastIndexOf('.'));
                foundPath = foundPath.replaceAll("/", ".");
                scanAndLoad(foundPath);
            }
        }
    }

    /**
     * Returns a list of uninitialized subclasses of the given class
     * or interface. Note: The classes are not initialized!
     */
    public List<Class<?>> findSubclasses(Class<?> superClass) {
        List<Class<?>> foundSubclasses = new LinkedList<>();

        for(Class<?> candidateSubclass : availableClasses) {
            if(superClass.isAssignableFrom(candidateSubclass) && superClass != candidateSubclass) {
                foundSubclasses.add(candidateSubclass);
            }
        }

        return foundSubclasses;
    }

    /**
     * Returns a list of uninitialized classes matching the simple name.
     * Note: The classes are not initialized!
     */
    public List<Class<?>> findClassesFromSimpleName(String className) {
        List<Class<?>> foundClasses = new LinkedList<>();

        for(Class<?> candidateClass : availableClasses) {
            if(candidateClass.getName().endsWith("."+className)) {
                try {
                    foundClasses.add(candidateClass);
                } catch (Throwable ex) {
                    LOGGER.log(Level.SEVERE, "Could not find or instantiate a class that matched search pattern " + className, ex);
                }
            }
        }

        return foundClasses;
    }
}
