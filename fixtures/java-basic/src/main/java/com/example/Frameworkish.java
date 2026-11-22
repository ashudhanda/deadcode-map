package com.example;

import java.io.Serializable;

// Hand-written fixture for the Java analyzer (not copied from any
// repo): framework traps — annotations, native methods, serialization,
// Lombok / JPA stereotypes on the enclosing class.
@Service
public class Frameworkish implements Serializable {
  private static final long serialVersionUID = 1L;

  @Autowired
  private UserRepo repo;

  @Value("${app.name}")
  private String injected;

  @PostConstruct
  private void init() {
  }

  @JsonProperty("label")
  private String labelled() {
    return "x";
  }

  private native void pollEvents();

  private void deadInService() {
  }

  private int deadFieldInService;

  private void byNameOnly() {
  }

  public void reflection() throws Exception {
    getClass().getDeclaredMethod("byNameOnly");
  }
}

// Lombok generates accessors that read the fields, so the fields are
// REVIEW at most — and the class annotation keeps the method too.
@Data
class LombokBean {
  private String name;
  private int count;

  private void beanHelper() {
  }
}

// JPA reads the fields through the persistence provider.
@Entity
class OrderEntity {
  private Long id;

  private void entityHelper() {
  }
}
